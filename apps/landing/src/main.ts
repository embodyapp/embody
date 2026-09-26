import './styles/variables.css';
import './styles/reset.css';
import './styles/typography.css';
import './styles/components.css';
import './styles/animations.css';
import posthog, { posthogEnabled } from './posthog';

import gsap from 'gsap';
import { CODE_SAMPLES } from './data/code-samples';
import { CRM_ARCHITECTURE_LAYERS } from './data/crm-architecture';
import { LoFiPlayer } from './audio/lofi-synth';
import { initHeroScene } from './hero-scene';

// Initialize State
let activeSampleId = 'declaration';
let lofiInstance: LoFiPlayer | null = null;

// HTML escape helper
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Single-pass token highlighter helper
function tokenizeAndHighlight(
  code: string,
  regex: RegExp,
  getSpanClass: (match: RegExpExecArray) => string | null
): string {
  let result = '';
  let lastIndex = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(code.slice(lastIndex, match.index));
    }
    const tokenClass = getSpanClass(match);
    if (tokenClass) {
      result += `<span class="${tokenClass}">${escapeHtml(match[0])}</span>`;
    } else {
      result += escapeHtml(match[0]);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < code.length) {
    result += escapeHtml(code.slice(lastIndex));
  }

  return result;
}

// Language grammar regexes & tokenizers
const TS_REGEX = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:import|export|const|let|var|from|return|type|interface|as|default|function|class|extends)\b)|(\b(?:entity|field|state|action|policy|string|money|ref|enum|machine|expr|number|list|extend|compile|optional|default)\b|\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*:))|(\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null|undefined)\b)/g;

const JSON_REGEX = /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|(-?\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null)\b)/g;

const BASH_REGEX = /(#[^\n]*)|(^\$ [^\n]*)|(^✔ [^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(--[a-zA-Z0-9-]+)/gm;

const HTTP_REGEX = /(###[^\n]*)|(\b(?:POST|GET|PUT|DELETE|PATCH|HTTP\/1\.1|mutation)\b)|(\b(?:200 OK|201 Created|400 Bad Request|404 Not Found|500 Internal Server Error)\b)|(^[A-Za-z-]+(?=:))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+\b)/gm;

const SQL_REGEX = /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b(?:CREATE|TABLE|PRIMARY|KEY|DEFAULT|NOT|NULL|REFERENCES|TEXT|NUMERIC|CHECK|TIMESTAMPTZ|ALTER|ENABLE|ROW|LEVEL|SECURITY|POLICY|ON|USING|TRIGGER|AFTER|INSERT|OR|UPDATE|FOR|EACH|EXECUTE|FUNCTION)\b)|(\b\d+\b)/gi;

const GRAPHQL_REGEX = /("""[\s\S]*?"""|#[^\n]*)|("(?:[^"\\]|\\.)*")|(\b(?:type|enum|Mutation|Query|ID|String|Float|DateTime|mutation|schema)\b)|(@[a-zA-Z0-9_]+)/g;

// Syntax highlighter helper
function highlightCode(code: string, language: string): string {
  switch (language) {
    case 'typescript':
      return tokenizeAndHighlight(code, TS_REGEX, (m) => {
        if (m[1]) return 'token-comment';
        if (m[2]) return 'token-string';
        if (m[3]) return 'token-keyword';
        if (m[4]) return 'token-function';
        if (m[5]) return 'token-property';
        if (m[6]) return 'token-number';
        if (m[7]) return 'token-keyword';
        return null;
      });

    case 'json':
      return tokenizeAndHighlight(code, JSON_REGEX, (m) => {
        if (m[1]) return 'token-property';
        if (m[2]) return 'token-string';
        if (m[3]) return 'token-number';
        if (m[4]) return 'token-keyword';
        return null;
      });

    case 'bash':
      return tokenizeAndHighlight(code, BASH_REGEX, (m) => {
        if (m[1]) return 'token-comment';
        if (m[2]) return 'token-keyword';
        if (m[3]) return 'token-function';
        if (m[4]) return 'token-string';
        if (m[5]) return 'token-property';
        return null;
      });

    case 'http':
      return tokenizeAndHighlight(code, HTTP_REGEX, (m) => {
        if (m[1]) return 'token-comment';
        if (m[2]) return 'token-keyword';
        if (m[3]) return 'token-function';
        if (m[4]) return 'token-property';
        if (m[5]) return 'token-string';
        if (m[6]) return 'token-number';
        return null;
      });

    case 'sql':
      return tokenizeAndHighlight(code, SQL_REGEX, (m) => {
        if (m[1]) return 'token-comment';
        if (m[2]) return 'token-string';
        if (m[3]) return 'token-keyword';
        if (m[4]) return 'token-number';
        return null;
      });

    case 'graphql':
      return tokenizeAndHighlight(code, GRAPHQL_REGEX, (m) => {
        if (m[1]) return 'token-comment';
        if (m[2]) return 'token-string';
        if (m[3]) return 'token-keyword';
        if (m[4]) return 'token-function';
        return null;
      });

    default:
      return escapeHtml(code);
  }
}


// Render Projection Playground
function updatePlayground(sampleId: string) {
  activeSampleId = sampleId;
  const sample = CODE_SAMPLES.find(s => s.id === sampleId) || CODE_SAMPLES[0];

  // Update tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === sampleId);
  });

  // Update Meta
  const titleEl = document.getElementById('playground-title');
  const descEl = document.getElementById('playground-desc');
  const badgeEl = document.getElementById('playground-badge');
  const filenameEl = document.getElementById('playground-filename');
  const codeEl = document.getElementById('playground-code');

  if (titleEl) titleEl.textContent = sample.name;
  if (descEl) descEl.textContent = sample.description;
  if (badgeEl) badgeEl.textContent = sample.badge;
  if (filenameEl) filenameEl.textContent = sample.filename;

  if (codeEl) {
    codeEl.innerHTML = highlightCode(sample.code, sample.language);
  }
}

// Render CRM Architecture Blueprint Diagram
function renderArchitectureDiagram() {
  const container = document.getElementById('architecture-diagram');
  if (!container) return;

  container.innerHTML = `
    <div class="arch-flow-wrapper">
      <div class="arch-app-badge-banner">
        <div class="arch-app-icon">💼</div>
        <div>
          <h4>B2B CRM &amp; Deal Pipeline App</h4>
          <p>Pure declarative manifest compiled over 4 constitutional layers</p>
        </div>
      </div>

      <div class="arch-layers-stack">
        ${CRM_ARCHITECTURE_LAYERS.map((layer, lIdx) => `
          <div class="arch-layer-card" style="border-left: 6px solid ${layer.layerColor};">
            <div class="arch-layer-header">
              <div class="arch-layer-title-group">
                <span class="arch-layer-pill" style="background: ${layer.layerColor}22; color: ${layer.layerColor}; border-color: ${layer.layerColor};">Layer 0${lIdx + 1}</span>
                <h3>${layer.layerName}</h3>
              </div>
              <span class="arch-layer-sub">${layer.layerSubtitle}</span>
            </div>

            <div class="arch-nodes-grid">
              ${layer.nodes.map(node => `
                <div class="arch-node-item" style="border-top: 3px solid ${node.accentColor};">
                  <div class="arch-node-top">
                    <span class="arch-node-num" style="background: ${node.accentBg}; color: ${node.accentColor};">${node.num}</span>
                    <span class="arch-node-primitive">${node.primitive}</span>
                    <span class="arch-node-badge" style="background: ${node.accentBg}; color: ${node.accentColor};">${node.badge}</span>
                  </div>
                  <p class="arch-node-role">${node.roleInCrm}</p>
                  <div class="arch-node-code">
                    <code>${node.codeSnippet}</code>
                  </div>
                </div>
              `).join('')}
            </div>

            ${lIdx < CRM_ARCHITECTURE_LAYERS.length - 1 ? `
              <div class="arch-layer-connector">
                <div class="connector-line"></div>
                <div class="connector-badge">Compiles Downwards &darr;</div>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>

      <!-- Projection Outputs Summary Bar -->
      <div class="arch-projections-summary">
        <div class="arch-proj-title">
          <span>✨ Automatic Projected Artifacts</span>
          <small>Guaranteed by <code>embody.lock</code> v2 hash signature</small>
        </div>
        <div class="arch-proj-tags">
          <span class="proj-pill">PostgreSQL Tables &amp; RLS</span>
          <span class="proj-pill">CLI Deal Engine</span>
          <span class="proj-pill">MCP AI Agent Tools</span>
          <span class="proj-pill">REST &amp; OpenAPI Spec</span>
          <span class="proj-pill">GraphQL Endpoints</span>
          <span class="proj-pill">Headless Pipeline UI Schemas</span>
        </div>
      </div>
    </div>
  `;
}

// Setup Rex Agentic MCP Simulator
function setupAgentSandbox() {
  const amountSlider = document.getElementById('rex-order-amount') as HTMLInputElement | null;
  const amountLabel = document.getElementById('rex-amount-display');
  const dryRunCheck = document.getElementById('rex-dry-run') as HTMLInputElement | null;
  const runBtn = document.getElementById('rex-execute-btn');
  const outputEl = document.getElementById('rex-terminal-output');

  if (!amountSlider || !runBtn || !outputEl) return;

  const updateAmount = () => {
    if (amountLabel) amountLabel.textContent = `$${amountSlider.value}.00`;
  };

  amountSlider.addEventListener('input', updateAmount);

  runBtn.addEventListener('click', () => {
    const amount = Number(amountSlider.value);
    const isDryRun = dryRunCheck?.checked ?? false;

    if (posthogEnabled) {
      posthog.capture('sandbox_run', {
        execution_mode: isDryRun ? 'dry_run' : 'live',
        amount_range: amount > 500 ? 'over_budget' : 'within_budget',
      });
    }

    outputEl.innerHTML = `<span class="token-comment">// Rex dispatched MCP tool call: crm_advance_stage...</span>\n`;

    setTimeout(() => {
      if (amount > 500) {
        outputEl.innerHTML += `
<span style="color: #D66248; font-weight: 700;">⛔ [EMBDY-REFUSAL E4102] ACTOR_BUDGET_EXCEEDED</span>
  Actor:      agent:deal-desk:rex-09
  Requested:  Operation discount override ($${amount}.00 USD)
  Budget Max: $500.00 USD / transaction
  Action:     Refused before side effects. Audit ledger hash chained.`;
      } else if (isDryRun) {
        outputEl.innerHTML += `
<span style="color: #4E9B8F; font-weight: 700;">🧪 [DRY RUN VALIDATION PASSED]</span>
  Actor:      agent:deal-desk:rex-09
  Target:     DEAL-8402 (Advance: qualified → proposal)
  Simulation: Discount policy verified (15% <= 20% max). Tenant isolated.
  State:      Preconditions valid with zero state mutations.`;
      } else {
        outputEl.innerHTML += `
<span style="color: #FDB849; font-weight: 700;">✅ [TRANSACTION COMMITTED]</span>
  Deal:       DEAL-8402 ("Acme Corp Global Cloud Migration")
  Transition: qualified → proposal ($120,000 ARR)
  Actor:      agent:deal-desk:rex-09
  Audit Hash: sha256:8f92a1c0d4e3...
  Policy:     Discount rule passed (15% within auto-approval limits).`;
      }
    }, 150);
  });
}

// Setup Copy Buttons
function setupCopyButtons() {
  document.querySelectorAll('.copy-btn, .copy-command-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const textToCopy = btn.getAttribute('data-copy') || '';
      if (textToCopy) {
        if (posthogEnabled) {
          posthog.capture('code_sample_copied', {
            copy_target: textToCopy.startsWith('npx skills add embodyapp/embody')
              ? 'skill_install'
              : btn.getAttribute('id') || 'documentation_snippet',
          });
        }
        void navigator.clipboard.writeText(textToCopy);
        const originalText = btn.textContent;
        btn.textContent = 'Copied! ✨';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 1800);
      }
    });
  });

  // Copy code from playground
  const copyPlaygroundBtn = document.getElementById('copy-playground-code');
  if (copyPlaygroundBtn) {
    copyPlaygroundBtn.addEventListener('click', () => {
      const sample = CODE_SAMPLES.find(s => s.id === activeSampleId);
      if (sample) {
        if (posthogEnabled) {
          posthog.capture('code_sample_copied', {
            copy_target: 'playground',
            sample_id: sample.id,
          });
        }
        void navigator.clipboard.writeText(sample.code);
        copyPlaygroundBtn.textContent = 'Copied! ✨';
        setTimeout(() => {
          copyPlaygroundBtn.textContent = 'Copy Code';
        }, 1800);
      }
    });
  }
}

// Start audio synchronously in the click gesture for mobile browser autoplay rules.
function setupLoFiPlayer() {
  const vinylBtn = document.getElementById('vinyl-toggle');
  const vinylDisc = document.getElementById('vinyl-disc');
  const vinylStatus = document.getElementById('vinyl-status');

  if (!vinylBtn || !vinylDisc) return;

  vinylBtn.addEventListener('click', () => {
    lofiInstance ??= new LoFiPlayer();
    const isPlaying = lofiInstance.toggle();
    if (posthogEnabled) posthog.capture('lofi_player_toggled', { is_playing: isPlaying });
    vinylDisc.classList.toggle('vinyl-spinning', isPlaying);
    vinylBtn.textContent = isPlaying ? 'Pause' : 'Play';
    vinylBtn.setAttribute('aria-pressed', String(isPlaying));
    vinylBtn.setAttribute('aria-label', isPlaying ? 'Pause Coastline FM' : 'Play Coastline FM');
    if (vinylStatus) vinylStatus.textContent = isPlaying ? 'Playing · original 92 BPM coastal groove' : 'Original groove · press play to listen';
  });
}

// Snappy Hero Entrance (Zero blocking)
function initHeroEntrance() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  gsap.fromTo(
    ['.hero-sticker-row', '.hero-title', '.hero-description', '.hero-cta-group', '.hero-metrics-row', '.visual-art-card'],
    { opacity: 0, y: 15 },
    { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out' }
  );
}

// Setup Extendability Mode Switcher
function setupExtendabilityShowcase() {
  const toggleBtns = document.querySelectorAll('.toggle-pill-btn');
  const canvasEl = document.getElementById('extend-canvas');
  const cardB2B = document.getElementById('card-b2b');
  const cardEcom = document.getElementById('card-ecom');
  const wireB2B = document.querySelector<SVGPathElement>('.branch-wire-b2b');
  const wireEcom = document.querySelector<SVGPathElement>('.branch-wire-ecom');

  if (!toggleBtns.length || !canvasEl) return;

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-ext-mode') || 'all';

      if (posthogEnabled) {
        posthog.capture('extendability_mode_selected', { mode });
      }

      // Update active toggle button
      toggleBtns.forEach(b => b.classList.toggle('active', b === btn));

      // Reset mode classes on canvas
      canvasEl.classList.remove('canvas-mode-b2b', 'canvas-mode-ecom');

      if (mode === 'b2b') {
        canvasEl.classList.add('canvas-mode-b2b');
        if (cardB2B) {
          gsap.fromTo(cardB2B, { scale: 0.98 }, { scale: 1.02, duration: 0.3, ease: 'power2.out' });
        }
        if (wireB2B) gsap.to(wireB2B, { strokeWidth: 5, duration: 0.3 });
        if (wireEcom) gsap.to(wireEcom, { strokeWidth: 1.5, duration: 0.3 });
      } else if (mode === 'ecom') {
        canvasEl.classList.add('canvas-mode-ecom');
        if (cardEcom) {
          gsap.fromTo(cardEcom, { scale: 0.98 }, { scale: 1.02, duration: 0.3, ease: 'power2.out' });
        }
        if (wireEcom) gsap.to(wireEcom, { strokeWidth: 5, duration: 0.3 });
        if (wireB2B) gsap.to(wireB2B, { strokeWidth: 1.5, duration: 0.3 });
      } else {
        if (cardB2B) gsap.to(cardB2B, { scale: 1, duration: 0.3 });
        if (cardEcom) gsap.to(cardEcom, { scale: 1, duration: 0.3 });
        if (wireB2B) gsap.to(wireB2B, { strokeWidth: 3.5, duration: 0.3 });
        if (wireEcom) gsap.to(wireEcom, { strokeWidth: 3.5, duration: 0.3 });
      }
    });
  });
}

// Beta Signup Form Integration with Google Forms
const GOOGLE_FORM_CONFIG = {
  formId: '1FAIpQLSf6z6c00hg3DbjIX1AVQ0bUBLNtGyoybqAWX06Q_f6tR5svJA',
  emailEntryId: 'entry.1271661547',
};

function setupBetaSignupForms() {
  const forms = document.querySelectorAll<HTMLFormElement>('.beta-signup-form');
  if (!forms.length) return;

  // Create hidden iframe for bulletproof background form submission
  let hiddenIframe = document.getElementById('gform-hidden-iframe') as HTMLIFrameElement | null;
  if (!hiddenIframe) {
    hiddenIframe = document.createElement('iframe');
    hiddenIframe.id = 'gform-hidden-iframe';
    hiddenIframe.name = 'gform-hidden-iframe';
    hiddenIframe.style.display = 'none';
    hiddenIframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hiddenIframe);
  }

  // Check if previously signed up in this browser
  const savedEmail = localStorage.getItem('embody_beta_email');
  if (savedEmail && posthogEnabled) {
    posthog.identify(savedEmail, { email: savedEmail });
  }

  forms.forEach(form => {
    const emailInput = form.querySelector<HTMLInputElement>('.beta-email-input');
    const submitBtn = form.querySelector<HTMLButtonElement>('.btn-cta');
    const feedbackEl = form.querySelector<HTMLDivElement>('.form-feedback');

    if (savedEmail && feedbackEl && emailInput) {
      emailInput.value = savedEmail;
      feedbackEl.className = 'form-feedback is-success';
      feedbackEl.innerHTML = `<span>✓ You're on the beta access list! We'll notify you soon.</span>`;
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!emailInput || !submitBtn || !feedbackEl) return;

      const email = emailInput.value.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!email || !emailRegex.test(email)) {
        if (posthogEnabled) {
          posthog.capture('beta_signup_validation_failed');
        }
        feedbackEl.className = 'form-feedback is-error';
        feedbackEl.innerHTML = `<span>⚠️ Please enter a valid email address.</span>`;
        emailInput.focus();
        return;
      }

      // Read form ID and entry ID from data attributes with config fallback
      const formId = form.getAttribute('data-form-id') || GOOGLE_FORM_CONFIG.formId;
      const rawEntryId = form.getAttribute('data-entry-id') || '1271661547';
      const entryId = rawEntryId.startsWith('entry.') ? rawEntryId : `entry.${rawEntryId}`;
      const actionUrl = `https://docs.google.com/forms/d/e/${formId}/formResponse`;

      // Loading state
      const originalBtnText = submitBtn.innerText;
      submitBtn.disabled = true;
      submitBtn.innerText = 'Submitting...';
      emailInput.disabled = true;
      feedbackEl.className = 'form-feedback';
      feedbackEl.textContent = '';

      try {
        // Method 1: Dual dispatch using fetch with mode: 'no-cors'
        const formData = new FormData();
        formData.append(entryId, email);

        fetch(actionUrl, {
          method: 'POST',
          mode: 'no-cors',
          body: formData,
        }).catch(() => {
          // fetch no-cors errors are ignored
        });

        // Method 2: Dynamic hidden form submitted into hidden iframe to ensure delivery
        const hiddenForm = document.createElement('form');
        hiddenForm.action = actionUrl;
        hiddenForm.method = 'POST';
        hiddenForm.target = 'gform-hidden-iframe';
        hiddenForm.style.display = 'none';

        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = entryId;
        hiddenInput.value = email;
        hiddenForm.appendChild(hiddenInput);

        document.body.appendChild(hiddenForm);
        hiddenForm.submit();
        setTimeout(() => hiddenForm.remove(), 1000);

        // Success state
        if (posthogEnabled) {
          posthog.identify(email, { email });
          posthog.capture('beta_signup_submitted', { email });
        }
        localStorage.setItem('embody_beta_email', email);
        submitBtn.innerText = 'Joined! ✓';
        feedbackEl.className = 'form-feedback is-success';
        feedbackEl.innerHTML = `<span>🎉 You're on the list! We'll invite you to the private beta shortly.</span>`;

        // Update other signup forms on the page
        forms.forEach(otherForm => {
          if (otherForm !== form) {
            const otherFeedback = otherForm.querySelector<HTMLDivElement>('.form-feedback');
            const otherInput = otherForm.querySelector<HTMLInputElement>('.beta-email-input');
            const otherBtn = otherForm.querySelector<HTMLButtonElement>('.btn-cta');
            if (otherFeedback) {
              otherFeedback.className = 'form-feedback is-success';
              otherFeedback.innerHTML = `<span>✓ You're on the list (${escapeHtml(email)})!</span>`;
            }
            if (otherInput) {
              otherInput.value = email;
              otherInput.disabled = true;
            }
            if (otherBtn) {
              otherBtn.disabled = true;
              otherBtn.innerText = 'Joined! ✓';
            }
          }
        });
      } catch {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
        emailInput.disabled = false;
        feedbackEl.className = 'form-feedback is-error';
        feedbackEl.innerHTML = `<span>Something went wrong. Please try again or visit our GitHub.</span>`;
      }
    });
  });

  // Smooth scroll and focus on email input when clicking nav beta button
  document.querySelectorAll('.btn-nav-beta').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (posthogEnabled) {
        posthog.capture('beta_signup_cta_clicked', { placement: 'navigation' });
      }
      const heroInput = document.querySelector<HTMLInputElement>('#hero-beta-form .beta-email-input');
      if (heroInput) {
        heroInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => heroInput.focus(), 500);
      }
    });
  });
}

function setupTestimonialCarousel() {
  const carousel = document.querySelector<HTMLElement>('.testimonial-carousel');
  const track = document.querySelector<HTMLElement>('#testimonial-track');
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.testimonial-card'));
  const previous = document.querySelector<HTMLButtonElement>('#testimonial-prev');
  const next = document.querySelector<HTMLButtonElement>('#testimonial-next');
  const dotsContainer = document.querySelector<HTMLElement>('#testimonial-dots');

  if (!carousel || !track || !cards.length || !previous || !next || !dotsContainer) return;

  let currentIndex = 0;
  let timer: number | undefined;

  const visibleCards = () => window.matchMedia('(max-width: 768px)').matches ? 1 : 2;
  const maxIndex = () => Math.max(0, cards.length - visibleCards());

  const renderDots = () => {
    dotsContainer.replaceChildren();
    for (let index = 0; index <= maxIndex(); index += 1) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'testimonial-dot';
      dot.setAttribute('aria-label', `Show testimonial page ${index + 1}`);
      dot.addEventListener('click', () => goTo(index));
      dotsContainer.appendChild(dot);
    }
  };

  const update = () => {
    currentIndex = Math.min(currentIndex, maxIndex());
    const gap = Number.parseFloat(window.getComputedStyle(track).gap) || 0;
    const step = cards[0].getBoundingClientRect().width + gap;
    track.style.transform = `translateX(-${currentIndex * step}px)`;

    dotsContainer.querySelectorAll('.testimonial-dot').forEach((dot, index) => {
      const isActive = index === currentIndex;
      dot.classList.toggle('active', isActive);
      dot.setAttribute('aria-current', isActive ? 'true' : 'false');
    });
  };

  const goTo = (index: number) => {
    currentIndex = index < 0 ? maxIndex() : index > maxIndex() ? 0 : index;
    update();
  };

  const stopAutoPlay = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };

  const startAutoPlay = () => {
    stopAutoPlay();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = window.setInterval(() => goTo(currentIndex + 1), 6000);
  };

  previous.addEventListener('click', () => {
    goTo(currentIndex - 1);
    startAutoPlay();
  });
  next.addEventListener('click', () => {
    goTo(currentIndex + 1);
    startAutoPlay();
  });
  carousel.addEventListener('mouseenter', stopAutoPlay);
  carousel.addEventListener('mouseleave', startAutoPlay);
  carousel.addEventListener('focusin', stopAutoPlay);
  carousel.addEventListener('focusout', startAutoPlay);
  window.addEventListener('resize', () => {
    renderDots();
    update();
  });

  renderDots();
  update();
  startAutoPlay();
}

function setupCtaTracking() {
  document.querySelectorAll<HTMLElement>('.cta-track').forEach(link => {
    link.addEventListener('click', () => {
      if (posthogEnabled) {
        posthog.capture('primary_cta_clicked', {
          placement: link.dataset.cta ?? 'unknown',
          destination: link.getAttribute('href'),
        });
      }
    });
  });
}

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  renderArchitectureDiagram();
  updatePlayground('declaration');

  // Playground Tab Listeners
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      if (tabId) {
        if (posthogEnabled) {
          posthog.capture('code_sample_selected', { sample_id: tabId });
        }
        updatePlayground(tabId);
      }
    });
  });

  setupExtendabilityShowcase();
  setupAgentSandbox();
  setupCopyButtons();
  setupLoFiPlayer();
  initHeroScene();
  initHeroEntrance();
  setupBetaSignupForms();
  setupTestimonialCarousel();
  setupCtaTracking();
});

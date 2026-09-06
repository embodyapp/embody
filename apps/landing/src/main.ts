import './styles/variables.css';
import './styles/reset.css';
import './styles/typography.css';
import './styles/components.css';
import './styles/animations.css';

import gsap from 'gsap';
import { CODE_SAMPLES } from './data/code-samples';
import { CRM_ARCHITECTURE_LAYERS } from './data/crm-architecture';

// Initialize State
let activeSampleId = 'declaration';
let lofiInstance: import('./audio/lofi-synth').LoFiPlayer | null = null;

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
          <small>Guaranteed by <code>embdy.lock</code> v2 hash signature</small>
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

    outputEl.innerHTML = `<span class="token-comment">// Dispatching MCP tool call: crm_advance_stage (actor: agent:deal-desk:rex-09)...</span>\n`;

    setTimeout(() => {
      if (amount > 500) {
        outputEl.innerHTML += `
<span style="color: #D66248; font-weight: 700;">⛔ [EMBDY-REFUSAL E4102] ACTOR_BUDGET_EXCEEDED</span>
  Actor:      agent:deal-desk:rex-09 (role: ai_agent)
  Requested:  Operation spend ($${amount}.00 USD)
  Budget Max: $500.00 USD / transaction limit
  Action:     Refused before execution. Mechanical policy protected state.
  Audit Hash: sha256:e1a90c4b...`;
      } else if (isDryRun) {
        outputEl.innerHTML += `
<span style="color: #4E9B8F; font-weight: 700;">🧪 [DRY RUN VALIDATION PASSED]</span>
  Actor:      agent:deal-desk:rex-09 (role: ai_agent)
  Target:     DEAL-8402 (Advance: qualified → proposal)
  Simulation: Spend $${amount}.00 <= $500.00 cap. Discount within 20% limit.
  State:      Preconditions valid. Zero database mutations committed.`;
      } else {
        outputEl.innerHTML += `
<span style="color: #FDB849; font-weight: 700;">✅ [TRANSACTION COMMITTED]</span>
  Deal:       DEAL-8402 ("Acme Corp Global Cloud Migration")
  Transition: qualified → proposal ($120,000 ARR)
  Actor:      agent:deal-desk:rex-09 (role: ai_agent)
  Spend Used: $${amount}.00 (Hard limit: $500.00)
  Audit Hash: sha256:8f92a1c0d4e3...
  Policy:     Passed mechanical discount rule & FSM constraints.`;
      }
    }, 150);
  });
}

// Setup Copy Buttons
function setupCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const textToCopy = btn.getAttribute('data-copy') || '';
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy);
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
        navigator.clipboard.writeText(sample.code);
        copyPlaygroundBtn.textContent = 'Copied! ✨';
        setTimeout(() => {
          copyPlaygroundBtn.textContent = 'Copy Code';
        }, 1800);
      }
    });
  }
}

// Hero Canvas Dynamic Animation Controller (Drive loop & Day/Night Cycle)
let driveTimeline: gsap.core.Timeline | null = null;
let dayNightTimeline: gsap.core.Timeline | null = null;
let starsTimeline: gsap.core.Timeline | null = null;

function initHeroCanvasAnimations() {
  const svgEl = document.getElementById('hero-art-svg');
  if (!svgEl) return;

  // 1. High-speed Coastal Drive Loop
  driveTimeline = gsap.timeline({ repeat: -1, paused: true });

  // Highway dashed line motion (giving the continuous driving speed illusion)
  driveTimeline.to('#road-lines', {
    strokeDashoffset: -60,
    duration: 0.35,
    ease: 'none',
    repeat: -1,
  }, 0);

  // Car chassis suspension bobbing & road bump tilt
  driveTimeline.to('#car-chassis', {
    y: -2.5,
    duration: 0.15,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0);

  driveTimeline.to('#car-chassis', {
    rotation: 0.7,
    transformOrigin: '40px 48px',
    duration: 0.28,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0);

  // Spinning Wheels
  driveTimeline.to('.car-wheel-hub', {
    rotation: 360,
    duration: 0.4,
    repeat: -1,
    ease: 'none',
    transformOrigin: '0px 0px',
  }, 0);

  // Robot Agent Co-Pilot responsive bobbing & telemetry pulse
  driveTimeline.to('#robot-agent-companion', {
    y: -2,
    rotation: -0.6,
    transformOrigin: '73px 20px',
    duration: 0.18,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0.04);

  driveTimeline.to('#robot-antenna-tip', {
    scale: 1.35,
    fill: '#FDB849',
    duration: 0.6,
    yoyo: true,
    repeat: -1,
    ease: 'power1.inOut',
    transformOrigin: 'center center',
  }, 0);

  driveTimeline.to('#sensor-pulse-wave', {
    scale: 1.4,
    opacity: 0.2,
    duration: 0.8,
    repeat: -1,
    ease: 'power2.out',
    transformOrigin: '0px -15px',
  }, 0);

  // Car Exhaust Smoke Puffs
  const exhaustTl = gsap.timeline({ repeat: -1 });
  exhaustTl
    .fromTo('.puff-1', { opacity: 0, scale: 0.4, x: 0 }, { opacity: 0.8, scale: 1, x: -8, duration: 0.22, ease: 'power1.out' })
    .to('.puff-1', { opacity: 0, scale: 1.5, x: -16, duration: 0.18, ease: 'power1.in' })
    .fromTo('.puff-2', { opacity: 0, scale: 0.4, x: -4 }, { opacity: 0.7, scale: 1.1, x: -14, duration: 0.22, ease: 'power1.out' }, '-=0.2')
    .to('.puff-2', { opacity: 0, scale: 1.6, x: -22, duration: 0.18, ease: 'power1.in' })
    .fromTo('.puff-3', { opacity: 0, scale: 0.4, x: -8 }, { opacity: 0.6, scale: 1.2, x: -20, duration: 0.22, ease: 'power1.out' }, '-=0.2')
    .to('.puff-3', { opacity: 0, scale: 1.8, x: -30, duration: 0.18, ease: 'power1.in' });
  driveTimeline.add(exhaustTl, 0);

  // Palm Fronds Swaying in the Coast Breeze
  driveTimeline.to('#palm-fronds', {
    rotation: 3.5,
    transformOrigin: '35px 15px',
    duration: 2.2,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0);

  // Ocean Shimmering Wave Drift
  driveTimeline.to('.wave-1, .wave-3', {
    x: 18,
    duration: 2.0,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0);
  driveTimeline.to('.wave-2, .wave-4', {
    x: -14,
    duration: 2.4,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  }, 0);

  // 2. Star Twinkle Timeline
  starsTimeline = gsap.timeline({ repeat: -1, paused: true });
  starsTimeline.to('.star-1', { scale: 1.4, opacity: 0.4, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut', stagger: 0.2 }, 0);
  starsTimeline.to('.star-2', { scale: 0.7, opacity: 1, duration: 1.1, yoyo: true, repeat: -1, ease: 'sine.inOut', stagger: 0.25 }, 0);
  starsTimeline.to('.star-3', { scale: 1.3, opacity: 0.5, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut', stagger: 0.18 }, 0);

  // 3. Continuous Day -> Sunset -> Night -> Dawn -> Day Atmosphere Cycle (24s infinite loop)
  dayNightTimeline = gsap.timeline({ repeat: -1, paused: true });

  // Initial Day State
  // 0s - 4s: Golden Afternoon
  // 4s - 9s: Sunset & Twilight Transition
  dayNightTimeline
    // Sky gradient shifts to fiery sunset then deep twilight
    .to('#skyStopTop', { attr: { 'stop-color': '#7A357E' }, duration: 4, ease: 'power1.inOut' }, 3)
    .to('#skyStopMid', { attr: { 'stop-color': '#D6456E' }, duration: 4, ease: 'power1.inOut' }, 3)
    .to('#skyStopBottom', { attr: { 'stop-color': '#FDB849' }, duration: 4, ease: 'power1.inOut' }, 3)

    // Sun sets down behind coastal mountains
    .to('#sky-sun', { y: 100, scale: 0.85, duration: 5, ease: 'power1.in' }, 3)
    .to('#sun-glow-circle', { opacity: 0.4, duration: 4 }, 3)

    // Twilight into Deep Starry Night (7s - 12s)
    .to('#skyStopTop', { attr: { 'stop-color': '#0C0A26' }, duration: 4, ease: 'power1.inOut' }, 7)
    .to('#skyStopMid', { attr: { 'stop-color': '#1E1B4B' }, duration: 4, ease: 'power1.inOut' }, 7)
    .to('#skyStopBottom', { attr: { 'stop-color': '#2C1D54' }, duration: 4, ease: 'power1.inOut' }, 7)

    // Distant Mountains shift to midnight purple/navy
    .to('#mount1Stop1', { attr: { 'stop-color': '#312E81' }, duration: 4 }, 7)
    .to('#mount1Stop2', { attr: { 'stop-color': '#1E1B4B' }, duration: 4 }, 7)
    .to('#mount2Stop1', { attr: { 'stop-color': '#1E1B4B' }, duration: 4 }, 7)
    .to('#mount2Stop2', { attr: { 'stop-color': '#0F172A' }, duration: 4 }, 7)

    // Ocean shifts to dark midnight reflections
    .to('#seaStopTop', { attr: { 'stop-color': '#1E293B' }, duration: 4 }, 7)
    .to('#seaStopBottom', { attr: { 'stop-color': '#0F172A' }, duration: 4 }, 7)

    // Stars fade in
    .to('#sky-stars', { opacity: 1, duration: 3, ease: 'power1.inOut' }, 8)

    // Glowing Moon rises into sky
    .fromTo('#sky-moon', { y: 120, x: 70, opacity: 0, scale: 0.7 }, { y: -110, x: 70, opacity: 1, scale: 1, duration: 6, ease: 'power1.out' }, 8)

    // Villa deck windows light up warm amber
    .to('.villa-window', { fill: '#FDB849', duration: 1.5, stagger: 0.15 }, 7.5)

    // Headlight beam turns ON as darkness arrives
    .to('#headlight-beam', { opacity: 0.85, duration: 2.5, ease: 'power2.inOut' }, 8)
    .to('#car-headlight-bulb', { fill: '#FFFBEA', duration: 1.5 }, 8)
    .to('#robot-visor', { fill: '#38BDF8', duration: 1.5 }, 8)
    .to('#robot-tablet rect', { fill: '#E0F2FE', duration: 1.5 }, 8)

    // Deep Midnight Cruising Peak (12s - 15s)
    .to({}, { duration: 3 })

    // Dawn & Sunrise Transition (15s - 20s)
    // Moon sinks down
    .to('#sky-moon', { y: -180, opacity: 0, scale: 0.7, duration: 4, ease: 'power1.in' }, 15)

    // Stars fade out
    .to('#sky-stars', { opacity: 0, duration: 3, ease: 'power1.inOut' }, 15)

    // Headlight beam fades OFF & Robot returns to daytime mode
    .to('#headlight-beam', { opacity: 0, duration: 3, ease: 'power2.inOut' }, 15.5)
    .to('#car-headlight-bulb', { fill: '#FFFDF9', duration: 2 }, 15.5)
    .to('#robot-visor', { fill: '#4E9B8F', duration: 2 }, 15.5)
    .to('#robot-tablet rect', { fill: '#A3D9C9', duration: 2 }, 15.5)

    // Villa windows turn off
    .to('.villa-window', { fill: '#2C2230', duration: 1.5 }, 16)

    // Dawn Pastel Colors
    .to('#skyStopTop', { attr: { 'stop-color': '#4338CA' }, duration: 3, ease: 'power1.inOut' }, 15)
    .to('#skyStopMid', { attr: { 'stop-color': '#F472B6' }, duration: 3, ease: 'power1.inOut' }, 15)
    .to('#skyStopBottom', { attr: { 'stop-color': '#FDE047' }, duration: 3, ease: 'power1.inOut' }, 15)

    // Sun rises back into the sky
    .to('#sky-sun', { y: 0, scale: 1, duration: 5, ease: 'power1.out' }, 16.5)
    .to('#sun-glow-circle', { opacity: 1, duration: 4 }, 16.5)

    // Mountain gradients return to day violet
    .to('#mount1Stop1', { attr: { 'stop-color': '#A084B6' }, duration: 4 }, 17)
    .to('#mount1Stop2', { attr: { 'stop-color': '#7A5E96' }, duration: 4 }, 17)
    .to('#mount2Stop1', { attr: { 'stop-color': '#56486E' }, duration: 4 }, 17)
    .to('#mount2Stop2', { attr: { 'stop-color': '#3A2D4F' }, duration: 4 }, 17)

    // Ocean returns to day turquoise
    .to('#seaStopTop', { attr: { 'stop-color': '#7BB8D4' }, duration: 4 }, 17)
    .to('#seaStopBottom', { attr: { 'stop-color': '#4E9B8F' }, duration: 4 }, 17)

    // Seamlessly return to original Day sky (20s - 24s)
    .to('#skyStopTop', { attr: { 'stop-color': '#7BB8D4' }, duration: 4, ease: 'power1.inOut' }, 20)
    .to('#skyStopMid', { attr: { 'stop-color': '#FDB849' }, duration: 4, ease: 'power1.inOut' }, 20)
    .to('#skyStopBottom', { attr: { 'stop-color': '#F27A3D' }, duration: 4, ease: 'power1.inOut' }, 20);
}

function startHeroArtCanvasAnimation() {
  if (driveTimeline) driveTimeline.play();
  if (dayNightTimeline) dayNightTimeline.play();
  if (starsTimeline) starsTimeline.play();
}

function pauseHeroArtCanvasAnimation() {
  if (driveTimeline) driveTimeline.pause();
  if (dayNightTimeline) dayNightTimeline.pause();
  if (starsTimeline) starsTimeline.pause();
}

// Setup Lo-Fi Audio Turntable Toggle (Lazy loads LoFiPlayer on click)
function setupLoFiPlayer() {
  const vinylBtn = document.getElementById('vinyl-toggle');
  const vinylDisc = document.getElementById('vinyl-disc');
  const vinylStatus = document.getElementById('vinyl-status');

  if (!vinylBtn || !vinylDisc) return;

  vinylBtn.addEventListener('click', async () => {
    if (!lofiInstance) {
      if (vinylStatus) vinylStatus.textContent = 'Loading audio synth...';
      const { LoFiPlayer } = await import('./audio/lofi-synth');
      lofiInstance = new LoFiPlayer();
    }

    const isPlaying = lofiInstance.toggle();
    if (isPlaying) {
      vinylDisc.classList.add('vinyl-spinning');
      if (vinylStatus) vinylStatus.textContent = 'Playing Lo-Fi Beats & Cracking Vinyl 🎶';
      vinylBtn.textContent = 'Mute';
      startHeroArtCanvasAnimation();
    } else {
      vinylDisc.classList.remove('vinyl-spinning');
      if (vinylStatus) vinylStatus.textContent = 'Click to spin lo-fi chill deck';
      vinylBtn.textContent = 'Play';
      pauseHeroArtCanvasAnimation();
    }
  });
}

// Snappy Hero Entrance (Zero blocking)
function initHeroEntrance() {
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
  const wireB2B = document.querySelector('.branch-wire-b2b') as SVGPathElement | null;
  const wireEcom = document.querySelector('.branch-wire-ecom') as SVGPathElement | null;

  if (!toggleBtns.length || !canvasEl) return;

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-ext-mode') || 'all';

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

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  renderArchitectureDiagram();
  updatePlayground('declaration');

  // Playground Tab Listeners
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      if (tabId) updatePlayground(tabId);
    });
  });

  setupExtendabilityShowcase();
  setupAgentSandbox();
  setupCopyButtons();
  setupLoFiPlayer();
  initHeroCanvasAnimations();
  initHeroEntrance();
});

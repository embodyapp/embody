import gsap from 'gsap';

/** A slow, self-contained golden-hour loop. Audio is optional, never required for motion. */
export function initHeroScene() {
  const scene = document.getElementById('hero-art-svg');
  if (!scene) return;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ambient = gsap.timeline({ repeat: -1, paused: true });
  ambient.to('#scene-clouds', { x: 15, duration: 12, ease: 'sine.inOut', yoyo: true, repeat: -1 }, 0);
  // Sway the whole palm from its base so the fronds never leave the trunk.
  ambient.to('#palm-tree', { rotation: 1.5, transformOrigin: '50% 100%', duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1 }, 0);
  ambient.to('.wave-1, .wave-3', { x: 12, opacity: 0.55, duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1 }, 0);
  ambient.to('.wave-2, .wave-4', { x: -10, opacity: 0.5, duration: 3.7, ease: 'sine.inOut', yoyo: true, repeat: -1 }, 0);
  ambient.to('#road-lines', { strokeDashoffset: -30, duration: 1.3, ease: 'none', repeat: -1 }, 0);
  // SVG groups use their bounding-box center, not CSS (0, 0), as the axle.
  ambient.to('.car-wheel-hub', { rotation: 360, transformOrigin: '50% 50%', duration: 2.4, ease: 'none', repeat: -1 }, 0);
  ambient.to('#car-chassis', { y: -1.2, rotation: 0.3, svgOrigin: '295 322', duration: 1.15, ease: 'sine.inOut', yoyo: true, repeat: -1 }, 0);
  ambient.fromTo('.exhaust-puff', { opacity: 0, x: 0, scale: 0.5 }, {
    opacity: 0.45, x: -18, y: -5, scale: 1.6, stagger: 0.35,
    duration: 1.5, ease: 'power1.out', repeat: -1,
  }, 0);

  // Stay in the site's warm palette rather than jumping to neon midnight.
  const light = gsap.timeline({ repeat: -1, paused: true });
  light.to('#skyStopTop', { attr: { 'stop-color': '#A084B6' }, duration: 10, ease: 'sine.inOut' }, 0);
  light.to('#skyStopMid', { attr: { 'stop-color': '#F7A66B' }, duration: 10, ease: 'sine.inOut' }, 0);
  light.to('#skyStopBottom', { attr: { 'stop-color': '#D66248' }, duration: 10, ease: 'sine.inOut' }, 0);
  light.to('#sky-sun', { y: 28, duration: 10, ease: 'sine.inOut' }, 0);
  light.to('.villa-window', { fill: '#FDB849', duration: 5 }, 6);
  light.to('#skyStopTop', { attr: { 'stop-color': '#7BB8D4' }, duration: 10, ease: 'sine.inOut' }, 10);
  light.to('#skyStopMid', { attr: { 'stop-color': '#FDB849' }, duration: 10, ease: 'sine.inOut' }, 10);
  light.to('#skyStopBottom', { attr: { 'stop-color': '#F27A3D' }, duration: 10, ease: 'sine.inOut' }, 10);
  light.to('#sky-sun', { y: 0, duration: 10, ease: 'sine.inOut' }, 10);
  light.to('.villa-window', { fill: '#2C2230', duration: 5 }, 14);

  let visible = true;
  const sync = () => {
    const active = visible && !document.hidden && !motionPreference.matches;
    if (active) { ambient.play(); light.play(); }
    else { ambient.pause(); light.pause(); }
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }, { threshold: 0.05 });
  observer.observe(scene);
  document.addEventListener('visibilitychange', sync);
  motionPreference.addEventListener('change', sync);
  sync();
}

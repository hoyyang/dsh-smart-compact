/**
 * Styles for the composer rollover button.
 *
 * Identity: deep-navy glass plate (constant across themes — the plate is always
 * dark, the same measured choice dsh-improve-prompt ships) + its own teal to
 * electric-blue to indigo ramp for the core. Animation vocabulary (orbit ring,
 * breathing core, press burst) is borrowed craft from dsh-plan-board's energy
 * core, re-tuned for a 31px circle; no colour is shared with sibling buttons.
 *
 * Layer order, bottom to top: halo (outside, behind) → plate → orbit ring →
 * core sprite → burst. The sprite is only ever a mask on .dsc-core; nothing is
 * drawn over it.
 *
 * @module dsh-smart-compact/client/styles
 */

export const STYLE_ATTR = 'dsh-smart-compact'

export const css = [
  `.dsc-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:31px;height:31px;padding:0;border-radius:999px;cursor:pointer;border:1px solid rgba(148,180,255,.24);background:linear-gradient(140deg,#101d38 0%,#0b1220 58%,#0d1730 100%);box-shadow:inset 0 1px 0 rgba(210,230,255,.18),inset 0 -6px 12px rgba(4,8,18,.55),0 1px 4px rgba(2,6,16,.4);transition:transform .18s ease,box-shadow .25s ease,border-color .25s ease;-webkit-user-select:none;user-select:none}`,
  `.dsc-btn:hover{border-color:rgba(94,234,212,.42);box-shadow:inset 0 1px 0 rgba(210,230,255,.22),inset 0 -6px 12px rgba(4,8,18,.55),0 0 16px rgba(45,212,191,.30),0 0 34px rgba(59,130,246,.22)}`,
  `.dsc-btn:active{transform:scale(.93)}`,
  `.dsc-btn:focus-visible{outline:2px solid rgba(94,234,212,.65);outline-offset:2px}`,
  `.dsc-btn[data-inert='true']{opacity:.45;cursor:default}`,

  // Halo: the hover-only ambient glow, painted outside the plate.
  `.dsc-btn::before{content:'';position:absolute;inset:-7px;border-radius:999px;background:radial-gradient(closest-side,rgba(45,212,191,.28),rgba(59,130,246,.14) 62%,transparent 78%);opacity:0;transition:opacity .28s ease;pointer-events:none}`,
  `.dsc-btn:hover::before{opacity:1}`,

  // Orbit ring: conic sweep, revealed and spinning on hover; solid and fast while busy.
  `.dsc-orbit{position:absolute;inset:-1px;border-radius:999px;padding:1.4px;background:conic-gradient(from 0deg,transparent 0turn,rgba(94,234,212,.95) .28turn,rgba(99,102,241,.85) .5turn,transparent .78turn);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;opacity:0;transition:opacity .25s ease;pointer-events:none}`,
  `.dsc-btn:hover .dsc-orbit{opacity:.9;animation:dsc-spin 3.2s linear infinite}`,
  `.dsc-btn[data-busy='true'] .dsc-orbit{opacity:1;animation:dsc-spin .9s linear infinite}`,

  // Core: the generated collapsing-window sprite as a mask, palette from code.
  `.dsc-core{position:relative;display:block;width:21px;height:21px;background:linear-gradient(180deg,#eafffb 0%,#5eead4 30%,#2dd4bf 48%,#3b82f6 78%,#6366f1 100%);background-size:100% 100%;animation:dsc-breathe 3.4s ease-in-out infinite;pointer-events:none}`,
  `.dsc-btn:hover .dsc-core{filter:brightness(1.18) saturate(1.1);animation-duration:2.2s}`,
  `.dsc-btn[data-busy='true'] .dsc-core{animation:dsc-roll .82s cubic-bezier(.55,0,.3,1) infinite}`,

  // Burst: press shockwave, re-keyed per click via data-busy flip.
  `.dsc-burst{position:absolute;inset:0;border-radius:999px;border:1.6px solid rgba(125,235,215,.85);opacity:0;transform:scale(.6);pointer-events:none}`,
  `.dsc-btn[data-busy='true'] .dsc-burst{animation:dsc-burst .62s ease-out forwards}`,

  `@keyframes dsc-spin{to{transform:rotate(360deg)}}`,
  `@keyframes dsc-breathe{0%,100%{opacity:.92;transform:scale(1)}50%{opacity:1;transform:scale(1.09)}}`,
  `@keyframes dsc-roll{0%{transform:scale(1) rotate(0deg)}55%{transform:scale(.78) rotate(200deg)}100%{transform:scale(1.06) rotate(360deg)}}`,
  `@keyframes dsc-burst{0%{opacity:.9;transform:scale(.62)}100%{opacity:0;transform:scale(1.85)}}`,
  `@media (prefers-reduced-motion:reduce){.dsc-btn:hover .dsc-orbit,.dsc-btn[data-busy='true'] .dsc-orbit,.dsc-core,.dsc-btn:hover .dsc-core,.dsc-btn[data-busy='true'] .dsc-core{animation:none}.dsc-btn[data-busy='true'] .dsc-burst{animation:none;opacity:0}}`,
].join('\n')

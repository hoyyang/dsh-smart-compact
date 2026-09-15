/**
 * Styles for the composer rollover button.
 *
 * Design contract with the row: the composer tool row is a family of small
 * circular colour chips with crisp white glyphs (the submit key is the blue
 * circle next door). The rollover button speaks that language — a bright
 * blue-to-indigo circle, a white collapsing-layers glyph — and gets its
 * "rollover" character from a dsh-image-generated vortex texture
 * (screen-blended into the plate: black vanishes, only light adds) plus a
 * white press burst. Distinct hue, shared shape language; nothing muddy, no
 * dark blob on either theme.
 *
 * Layer order, bottom to top: ::before halo (hover, outside) → plate gradient
 * → ::after vortex texture (screen-blend, spins on hover, rolls when busy) →
 * white glyph → burst ring. The texture never covers the glyph: blend screen
 * only adds light underneath it.
 *
 * @module dsh-smart-compact/client/styles
 */

import { VORTEX_URI } from './assets.js'

export const STYLE_ATTR = 'dsh-smart-compact'

export const css = [
  // Plate: bright blue→indigo circle — sibling of the send key, own hue.

  // Geometry: !important everywhere a host rule could reach, PLUS clip-path —
  // the user's real GUI still squashed the plate even under border-radius
  // !important (the host ships its own !important row-button rules), so the
  // shape is now physically clipped to a circle by a property no host theme
  // touches. The radius stays for children and pseudo-elements.
  `button.dsc-btn{position:relative !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;flex:none !important;width:26px !important;height:26px !important;min-width:26px !important;max-width:26px !important;min-height:26px !important;max-height:26px !important;aspect-ratio:1/1;padding:0 !important;border-radius:999px !important;clip-path:circle(50% at 50% 50%) !important;overflow:hidden !important;cursor:pointer !important;border:1px solid rgba(255,214,140,.4);background:linear-gradient(150deg,#a86e14 0%,#4a3208 52%,#7a5510 100%);box-shadow:inset 0 1px 0 rgba(255,230,170,.4),inset 0 -8px 14px rgba(30,18,2,.5),0 1px 5px rgba(60,35,0,.45);transition:transform .18s ease,box-shadow .25s ease,-webkit-filter .25s ease,filter .25s ease;-webkit-user-select:none;user-select:none}`,
  `.dsc-btn:hover{-webkit-filter:brightness(1.1);filter:brightness(1.1);box-shadow:inset 0 1px 0 rgba(255,230,170,.45),inset 0 -8px 14px rgba(30,18,2,.45),0 0 18px rgba(255,180,60,.5),0 1px 6px rgba(60,35,0,.5)}`,
  `.dsc-btn:active{transform:scale(.92)}`,
  `.dsc-btn:focus-visible{outline:2px solid rgba(255,190,80,.85);outline-offset:2px}`,
  `.dsc-btn[data-inert='true']{opacity:.45;cursor:default}`,
  // Inert must read as inert: no hover glow, no hover brightening, no vortex
  // speed-up, no press scale — a disabled-looking plate stays motionless.
  `.dsc-btn[data-inert='true']:hover{-webkit-filter:none;filter:none;box-shadow:inset 0 1px 0 rgba(255,230,170,.4),inset 0 -8px 14px rgba(30,18,2,.5),0 1px 5px rgba(60,35,0,.45)}`,
  `.dsc-btn[data-inert='true']:hover::before{opacity:0}`,
  `.dsc-btn[data-inert='true']:hover::after{opacity:.88;animation-duration:16s}`,
  `.dsc-btn[data-inert='true']:active{transform:none}`,
  `.dsc-btn[data-busy='true']{cursor:progress}`,

  // Halo: hover-only ambient glow outside the plate.
  `.dsc-btn::before{content:'';position:absolute;inset:-7px;border-radius:999px;background:radial-gradient(closest-side,rgba(255,180,60,.42),rgba(255,140,30,.16) 62%,transparent 78%);opacity:0;transition:opacity .28s ease;pointer-events:none}`,
  `.dsc-btn:hover::before{opacity:1}`,

  // Vortex: the generated texture, screen-blended so its black floor vanishes
  // into the plate. Idle breathes with an ultra-slow spin (alive, not noisy);
  // hover speeds up; the command running rolls it fast.
  `.dsc-btn::after{content:'';position:absolute;inset:1px;border-radius:999px;clip-path:circle(49.4% at 50% 50%);background:url("${VORTEX_URI}") center/132% 132% no-repeat;mix-blend-mode:screen;opacity:.88;pointer-events:none;transition:opacity .25s ease;animation:dsc-vortex-spin 16s linear infinite}`,
  `.dsc-btn:hover::after{opacity:1;animation-duration:5s}`,
  `.dsc-btn[data-busy='true']::after{opacity:1;animation-duration:.8s}`,

  // Glyph: crisp white collapsing-layers mark (converging chevrons + slot).
  // Double navy drop-shadow keeps the white strokes readable even where the
  // vortex core is at its brightest under them.

  // Burst: white press shockwave, re-keyed per click via the data-busy flip.
  `.dsc-burst{position:absolute;inset:0;border-radius:999px;border:1.6px solid rgba(255,225,170,.95);opacity:0;transform:scale(.6);pointer-events:none}`,
  `.dsc-btn[data-busy='true'] .dsc-burst{animation:dsc-burst .62s ease-out forwards}`,

  `@keyframes dsc-vortex-spin{to{transform:rotate(360deg)}}`,
  `@keyframes dsc-burst{0%{opacity:.9;transform:scale(.62)}100%{opacity:0;transform:scale(1.85)}}`,

  `@media (prefers-reduced-motion:reduce){.dsc-btn::after,.dsc-btn:hover::after,.dsc-btn[data-busy='true']::after,.dsc-btn[data-busy='true'] .dsc-g-top,.dsc-btn[data-busy='true'] .dsc-g-bot,.dsc-btn[data-busy='true'] .dsc-g-slot{animation:none}.dsc-btn[data-busy='true'] .dsc-burst{animation:none;opacity:0}}`,

  // Position: the host wraps each slot's entries in
  // <div data-slot=… style="display:contents"> (the SlotOutlet anchor), so the
  // button IS a flex item of the .trailing row
  // ([input.right entries…][model selector][ContextMeter][stop?][submit]) and
  // every child defaults to order:0 with DOM order deciding. Order 1 lifts the
  // button past model selector and meter; the submit — always the trailing
  // cluster's LAST child in the shipped row — is pinned to order 2 through the
  // :has() parent hook, so the button lands immediately left of the send key
  // and right of the context meter. @supports keeps a host without :has on
  // the stock position instead of drifting past the submit.
  `@supports selector(:has(*)){.dsc-btn{order:1}*:has(>[data-slot='conversation.input.right'])>:last-child:not(.dsc-btn){order:2}}`,
].join('\n')

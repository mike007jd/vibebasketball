import * as THREE from 'three';

/**
 * Input: keyboard + gamepad. Produces a unified per-player intent struct.
 *
 * Intent fields:
 *   move: {x, z} analog in world-relative camera space, magnitude 0..1
 *   sprint: bool
 *   shoot: bool (held)
 *   shootPressed / shootReleased: edge events (consumed on read)
 *   confirmPressed: gamepad A edge for UI actions (never keyboard Space)
 *   dribbleMove: 'cross' | 'btl' | 'behind' | 'spin' | 'hesitation' | null
 *   steal: bool edge
 *   contest: bool (== shoot on defense)
 */
class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();   // edge: cleared each frame after poll
    this.released = new Set();
    this.shootCommitted = false;
    this.shootReleasedCommitted = false;
    this.shootPressId = 0;
    // The four arrows are one digital Pro Stick. A short release is a handle
    // flick; holding one direction across the commit threshold is a shot /
    // finish intent. Duration advances on simulation time in poll(), so the
    // production loop and deterministic QA hook see the same input contract.
    this.skillActive = null;
    this.skillHoldT = 0;
    this.skillCommitSent = false;
    // One edge sampled for the next simulation frame. This is deliberately a
    // single current event, never a FIFO of future gameplay commands.
    this.skillReleaseEvent = null;
    // Monotonic locomotion edge. A handle take snapshots this value when it
    // starts; a later WASD/gamepad direction edge is an explicit cancel, while
    // movement that was already held before the take is not mistaken for one.
    this.moveSerial = 0;
    this.lastMoveSample = { x: 0, z: 0, mag: 0 };
    // Ten 60 Hz frames is still a handle flick in real play. A directional
    // gather requires a visibly stable hold, which prevents rolling combos
    // from being reinterpreted as four miniature shot attempts.
    this.skillThreshold = 0.23;
    this.gamepadIndex = null;
    this.prevGamepad = null;
    this.intent = {
      move: { x: 0, z: 0 },
      moveSerial: 0,
      sprint: false,
      shoot: false,
      shootPressed: false,
      shootReleased: false,
      confirmPressed: false,
      dribbleMove: null,
      stealPressed: false,
      pausePressed: false,
    };
    this.camKeys = [];
    this.uiKeys = [];

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.pressed.add(c);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(c)) this.moveSerial++;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) {
        // Sliding the digital stick into another direction completes the old
        // direction as a flick. Do this on the transition frame instead of
        // waiting for key-up so overlapping keyboard rolls remain combo-able.
        if (this.skillActive && this.skillActive !== c && !this.skillCommitSent) {
          this.skillReleaseEvent = {
            code: this.skillActive,
            committed: false,
            heldFor: this.skillHoldT,
          };
        }
        this.skillActive = c;
        this.skillHoldT = 0;
        this.skillCommitSent = false;
      }
      if (c === 'Space') {
        const id = ++this.shootPressId;
        this.shootCommitted = false;
        window.setTimeout(() => {
          if (this.shootPressId === id && this.keys.has('Space')) this.shootCommitted = true;
        }, 160);
      }
      // Tab has no gameplay meaning. Do not trap it: screen/brace actions must
      // come from explicit basketball state, never from browser focus input.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.shootReleasedCommitted = this.shootCommitted;
        this.shootCommitted = false;
        this.shootPressId++;
      }
      if (e.code === this.skillActive) {
        this.skillReleaseEvent = {
          code: e.code,
          committed: this.skillCommitSent || this.skillHoldT >= this.skillThreshold,
          heldFor: this.skillHoldT,
        };
        this.skillActive = null;
      }
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pressed.clear();
      this.released.clear();
      this.shootCommitted = false;
      this.shootReleasedCommitted = false;
      this.shootPressId++;
      this.skillActive = null;
      this.skillHoldT = 0;
      this.skillCommitSent = false;
      this.skillReleaseEvent = null;
    });

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.prevGamepad = null;
    });
  }

  poll(camera, dt = 1 / 60) {
    const it = this.intent;
    const k = this.keys;

    // --- movement (camera-relative) ---
    let ix = 0, iz = 0;
    if (k.has('KeyW')) iz -= 1;
    if (k.has('KeyS')) iz += 1;
    if (k.has('KeyA')) ix -= 1;
    if (k.has('KeyD')) ix += 1;
    let mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }

    // --- gamepad ---
    let pad = null;
    if (this.gamepadIndex != null) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      pad = pads[this.gamepadIndex] || null;
    }
    let padShootPressed = false, padShootReleased = false, padConfirmPressed = false, padSteal = false;
    let padShootCommitted = false, padShootReleasedCommitted = false;
    let padDribble = null, padSpin = false;
    if (pad) {
      const prevPad = this.prevGamepad ?? {};
      const lx = pad.axes[0] || 0, ly = pad.axes[1] || 0;
      const dead = 0.18;
      const lmag = Math.hypot(lx, ly);
      if (lmag > dead) {
        const s = Math.min(1, (lmag - dead) / (1 - dead)) / lmag;
        ix = lx * s; iz = ly * s; mag = Math.min(1, lmag * s);
      }
      it.sprint = (pad.buttons[7]?.value ?? 0) > 0.4 || (pad.buttons[10]?.pressed ?? false);
      const confirmNow = pad.buttons[0]?.pressed ?? false;
      const shootNow = confirmNow || (pad.buttons[2]?.pressed ?? false);
      const prevShoot = prevPad.shoot ?? false;
      padShootPressed = shootNow && !prevShoot;
      padShootReleased = !shootNow && prevShoot;
      padConfirmPressed = confirmNow && !(prevPad.confirm ?? false);
      const shootStartedAt = padShootPressed ? performance.now() : prevPad.shootStartedAt;
      padShootCommitted = shootNow && performance.now() - (shootStartedAt ?? performance.now()) >= 160;
      padShootReleasedCommitted = padShootReleased && !!prevPad.shootCommitted;

      const X = pad.buttons[2]?.pressed ?? false;   // X / square: dribble moves
      const Ybtn = pad.buttons[3]?.pressed ?? false; // Y / triangle: spin
      const prevX = prevPad.x ?? false;
      const prevY = prevPad.y ?? false;
      if (X && !prevX) padDribble = true;
      padSteal = (pad.buttons[4]?.pressed ?? false) && !(prevPad.lb ?? false); // LB
      if (Ybtn && !prevY) padSpin = true;
      this.prevGamepad = {
        shoot: shootNow,
        confirm: confirmNow,
        shootStartedAt: shootNow ? shootStartedAt : null,
        shootCommitted: padShootCommitted,
        x: X,
        y: Ybtn,
        lb: pad.buttons[4]?.pressed ?? false,
      };
    }

    // camera-relative movement basis
    if (camera) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      // screen right, for a camera looking down -z with +y up
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      // forward on screen is -z in world; input iz=-1 means forward
      const wx = fwd.x * (-iz) + right.x * ix;
      const wz = fwd.z * (-iz) + right.z * ix;
      it.move.x = wx; it.move.z = wz; it.moveMag = mag;
    }

    // Also detect controller starts and meaningful stick direction changes.
    // Keyboard keydown already increments the serial; a second increment on
    // the same frame is harmless because actions snapshot the final value.
    const prevMove = this.lastMoveSample;
    const moveDot = mag > 0.08 && prevMove.mag > 0.08
      ? (ix * prevMove.x + iz * prevMove.z) / (mag * prevMove.mag)
      : 1;
    if (mag > 0.08 && (prevMove.mag <= 0.08 || moveDot < 0.94)) this.moveSerial++;
    // Store raw stick space. A chase camera rotating around a continuously held
    // W key must not manufacture a fresh locomotion edge by changing the same
    // input's world-space vector.
    prevMove.x = ix;
    prevMove.z = iz;
    prevMove.mag = mag;
    it.moveSerial = this.moveSerial;

    // Keyboard mirrors the controller split: Shift is the right-trigger sprint;
    // Ctrl is the left-trigger body/stance modifier.
    if (!pad) it.sprint = k.has('ShiftLeft') || k.has('ShiftRight');

    // --- shoot ---
    const kbShoot = k.has('Space');
    const kbShootPressed = this.pressed.has('Space');
    const kbShootReleased = this.released.has('Space');
    it.shoot = kbShoot || (pad ? (this.prevGamepad?.shoot ?? false) : false);
    it.shootPressed = kbShootPressed || padShootPressed;
    it.shootReleased = kbShootReleased || padShootReleased;
    it.confirmPressed = padConfirmPressed;
    it.shootCommitted = this.shootCommitted || padShootCommitted;
    it.shootReleasedCommitted = kbShootReleased ? this.shootReleasedCommitted : padShootReleasedCommitted;

    // --- skill stick ---
    // WASD remains locomotion. Arrows are a second, camera-independent stick:
    // flick for a handle action, hold for a directional gather/finish.
    const skillName = (code) => code === 'ArrowLeft' ? 'left'
      : code === 'ArrowRight' ? 'right'
        : code === 'ArrowUp' ? 'up' : code === 'ArrowDown' ? 'down' : null;
    const activeSkill = this.skillActive && k.has(this.skillActive) ? this.skillActive : null;
    const heldSkillCount = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      .reduce((count, code) => count + (k.has(code) ? 1 : 0), 0);
    const skillPressedCode = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      .find((code) => this.pressed.has(code)) ?? null;
    // A shot/finish hold exists only after one direction has been stable by
    // itself. During an overlapping direction change the timer is frozen at
    // zero; aggregate time across several directions can never create a shot.
    if (activeSkill && heldSkillCount === 1) this.skillHoldT += Math.max(0, dt);
    else if (heldSkillCount !== 1) this.skillHoldT = 0;
    const commitNow = !!activeSkill && heldSkillCount === 1 && !this.skillCommitSent &&
      this.skillHoldT >= this.skillThreshold;
    if (commitNow) this.skillCommitSent = true;
    const releasedSkill = this.skillReleaseEvent;
    this.skillReleaseEvent = null;

    // A direction-transition edge describes the outgoing stick direction and
    // is consumed on this frame. It wins over the newly active direction so a
    // left->right roll executes left once instead of right twice.
    it.skillDirection = skillName(releasedSkill?.code ?? activeSkill ?? skillPressedCode);
    it.skillPressed = !!skillPressedCode;
    it.skillHeld = !!activeSkill;
    it.skillHoldT = activeSkill ? this.skillHoldT : (releasedSkill?.heldFor ?? 0);
    it.skillCommitted = commitNow;
    it.skillReleased = !!releasedSkill;
    it.skillReleaseCommitted = !!releasedSkill?.committed;
    it.skillFlick = !!releasedSkill && !releasedSkill.committed;

    // There is deliberately no second, hidden J/K/L-era command set.
    const kPressed = this.pressed.has('KeyK') || padSpin;

    it.dribbleMove = null;
    it.dribbleDir = 0;
    if (it.skillFlick) {
      it.dribbleMove = it.skillDirection === 'up' ? 'btl'
        : it.skillDirection === 'down' ? 'behind'
          : 'horizontal';
      it.dribbleDir = it.skillDirection === 'right' ? 1
        : it.skillDirection === 'left' ? -1 : 0;
    } else if (padDribble === true) {
      // Controller X/square remains a context move; the keyboard is arrow-only.
      it.dribbleMove = 'hesitation';
    }
    if (kPressed) it.dribbleMove = 'spin';

    // E sits beside movement and is usable while holding the defensive stance.
    it.stealPressed = this.pressed.has('KeyE') || padSteal;

    // --- physicality (NBA 2K's L2): one key, one idea — commit my body to the
    // man I am on. On defence that is the low stance and the box-out; with the
    // ball it is posting up and shielding.
    it.physical = k.has('ControlLeft') || k.has('ControlRight') ||
      (pad ? (this.prevGamepad?.lb ?? false) : false);
    // --- ui keys ---
    this.camKeys = [];
    this.uiKeys = [];
    if (this.pressed.has('KeyC')) this.camKeys.push('C');
    if (this.pressed.has('KeyP')) this.camKeys.push('P');
    if (this.pressed.has('KeyH')) this.camKeys.push('H');
    if (this.pressed.has('F3')) this.camKeys.push('F3');
    if (this.pressed.has('KeyR')) this.camKeys.push('R');
    if (this.pressed.has('Enter')) this.uiKeys.push('ENTER');

    this.pressed.clear();
    this.released.clear();
    this.shootReleasedCommitted = false;
    return it;
  }
}

export const input = new Input();

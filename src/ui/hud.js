export class HUD {
  constructor() {
    this.el = {
      nameA: document.getElementById('nameA'),
      nameB: document.getElementById('nameB'),
      scoreA: document.getElementById('scoreA'),
      scoreB: document.getElementById('scoreB'),
      mid: document.getElementById('score-mid'),
      target: document.getElementById('target-score'),
      shotClock: document.getElementById('shot-clock'),
      msg: document.getElementById('center-msg'),
      shotFb: document.getElementById('shot-feedback'),
      debug: document.getElementById('debug'),
      help: document.getElementById('controls-help'),
      loading: document.getElementById('loading'),
      meter: document.getElementById('shot-meter'),
      meterFill: document.querySelector('#shot-meter .sm-fill'),
      meterStable: document.querySelector('#shot-meter .sm-stable'),
      meterGreen: document.querySelector('#shot-meter .sm-green'),
      meterMark: document.querySelector('#shot-meter .sm-mark'),
      teamA: document.querySelector('.team.away'),
      teamB: document.querySelector('.team.home'),
      task: document.getElementById('possession-task'),
      context: document.getElementById('context-controls'),
    };
    this.msgTimer = 0;
    this.fbTimer = 0;
    this.debugOn = false;
    this.helpOn = true;
    this.controlContext = null;
  }

  setNames(a, b) {
    this.el.nameA.textContent = a;
    this.el.nameB.textContent = b;
  }

  setScore(a, b) {
    this.el.scoreA.textContent = a;
    this.el.scoreB.textContent = b;
  }

  scorePop(team) {
    const el = team === 0 ? this.el.scoreA : this.el.scoreB;
    el.classList.remove('score-pop');
    void el.offsetWidth;
    el.classList.add('score-pop');
  }

  setPossession(teamIdx) {
    this.el.teamA.classList.toggle('has-ball', teamIdx === 0);
    this.el.teamB.classList.toggle('has-ball', teamIdx === 1);
  }

  setTarget(t) {
    this.el.target.textContent = `TO ${t}`;
  }

  setShotClock(s) {
    const v = Math.max(0, Math.ceil(s));
    this.el.shotClock.textContent = v;
    this.el.shotClock.classList.toggle('low', s < 5.5);
  }

  msg(main, sub = '', dur = 1.6) {
    this.el.msg.innerHTML = `${main}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    this.el.msg.classList.add('show');
    this.msgTimer = dur;
  }

  shotFeedback(text, cls = '', detail = '') {
    this.el.shotFb.className = '';
    this.el.shotFb.innerHTML = `<strong>${text}</strong>${detail ? `<small>${detail}</small>` : ''}`;
    void this.el.shotFb.offsetWidth;
    this.el.shotFb.className = 'show ' + cls;
    this.fbTimer = cls === 'dunk' ? 0.72 : 1.25;
  }

  debug(text) {
    if (this.debugOn) this.el.debug.textContent = text;
  }

  toggleDebug() {
    this.debugOn = !this.debugOn;
    this.el.debug.classList.toggle('show', this.debugOn);
  }

  toggleHelp() {
    this.helpOn = !this.helpOn;
    this.el.help.classList.toggle('hidden', !this.helpOn);
  }

  setClearTask(active) {
    this.el.task?.classList.toggle('show', !!active);
  }

  setControlContext(mode) {
    if (!this.el.context || mode === this.controlContext) return;
    this.controlContext = mode;
    this.el.context.innerHTML = mode === 'offense'
      ? '<b>TAP ARROWS</b> HANDLE COMBOS <i></i><b>HOLD ARROW STEADY</b> HOP SHOT / FINISH <i></i><b>SHIFT+WASD</b> BURST <i></i><b>SPACE</b> FAKE / SHOOT'
      : '<b>CTRL</b> LOW STANCE <i></i><b>E</b> STEAL <i></i><b>SPACE</b> BLOCK / REBOUND';
  }

  /**
   * 2K-style release bar pinned beside the shooter.
   * progress/green0/green1/release are 0..1 up the bar.
   */
  shotMeter({ x, y, progress, stable0, stable1, green0, green1, release = null, color = null }) {
    const el = this.el;
    if (!el.meter) return;
    el.meter.classList.add('show');
    el.meter.style.left = `${x}px`;
    el.meter.style.top = `${y}px`;
    el.meterStable.style.bottom = `${stable0 * 100}%`;
    el.meterStable.style.height = `${Math.max(0, stable1 - stable0) * 100}%`;
    el.meterGreen.style.bottom = `${green0 * 100}%`;
    el.meterGreen.style.height = `${Math.max(0, green1 - green0) * 100}%`;
    el.meterFill.style.height = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    if (color) el.meterFill.style.background = color;
    else el.meterFill.style.background = 'linear-gradient(to top, #ffb347, #ffe08a)';
    if (release != null) {
      el.meter.classList.add('locked');
      el.meterMark.style.bottom = `${release * 100}%`;
    } else {
      el.meter.classList.remove('locked');
    }
  }

  hideShotMeter() {
    if (this.el.meter) this.el.meter.classList.remove('show');
  }

  doneLoading() {
    this.el.loading.classList.add('done');
  }

  update(dt) {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.el.msg.classList.remove('show');
    }
    if (this.fbTimer > 0) {
      this.fbTimer -= dt;
      if (this.fbTimer <= 0) this.el.shotFb.className = '';
    }
  }
}

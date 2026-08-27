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
      scoreboard: document.getElementById('scoreboard'),
      modeMenu: document.getElementById('mode-menu'),
      howTo: document.getElementById('how-to-play'),
      contestHud: document.getElementById('contest-hud'),
      contestStage: document.getElementById('contest-stage'),
      contestEntrant: document.getElementById('contest-entrant'),
      contestClock: document.getElementById('contest-clock'),
      contestClockWrap: document.querySelector('.contest-clock'),
      contestScore: document.getElementById('contest-score'),
      contestStation: document.getElementById('contest-station'),
      contestBallCount: document.getElementById('contest-ball-count'),
      contestAttempts: document.getElementById('contest-attempts'),
      contestRanking: document.getElementById('contest-ranking'),
      contestFinalists: document.getElementById('contest-roadmap-finalists'),
      contestRoadmapChampion: document.getElementById('contest-roadmap-champion'),
      contestCutoff: document.getElementById('contest-cutoff'),
      contestSkip: document.getElementById('contest-skip-live'),
      contestOverlay: document.getElementById('contest-overlay'),
      setupPanel: document.getElementById('contest-setup-panel'),
      setupTitle: document.getElementById('contest-setup-title'),
      setupCopy: document.getElementById('contest-setup-copy'),
      setupHint: document.getElementById('contest-setup-hint'),
      playerCountOptions: document.getElementById('player-count-options'),
      characterOptions: document.getElementById('character-select-options'),
      moneyPanel: document.getElementById('money-rack-panel'),
      moneyPlayer: document.getElementById('money-rack-player'),
      cpuPanel: document.getElementById('cpu-prompt-panel'),
      eliminationPanel: document.getElementById('contest-elimination-panel'),
      resultsPanel: document.getElementById('contest-results-panel'),
      cpuName: document.getElementById('cpu-name'),
      cpuRound: document.getElementById('cpu-round-label'),
      eliminationCopy: document.getElementById('contest-elimination-copy'),
      eliminationTitle: document.getElementById('contest-elimination-title'),
      eliminationRanking: document.getElementById('contest-elimination-ranking'),
      contestWinner: document.getElementById('contest-winner'),
      finalRanking: document.getElementById('contest-final-ranking'),
    };
    this.msgTimer = 0;
    this.fbTimer = 0;
    this.debugOn = false;
    this.helpOn = true;
    this.controlContext = null;
    this.mode = 'menu';
  }

  showModeMenu() {
    this.mode = 'menu';
    this.el.modeMenu?.classList.add('show');
    this.el.howTo?.classList.remove('show');
    this.el.scoreboard?.classList.add('hidden');
    this.el.contestHud?.classList.remove('show');
    this.hideContestOverlay();
    this.el.help?.classList.add('hidden');
    this.el.context?.classList.add('hidden');
  }

  showHowTo() {
    this.mode = 'how-to';
    this.el.modeMenu?.classList.remove('show');
    this.el.howTo?.classList.add('show');
    this.el.scoreboard?.classList.add('hidden');
    this.el.contestHud?.classList.remove('show');
    this.el.help?.classList.add('hidden');
    this.el.context?.classList.add('hidden');
  }

  setMode(mode) {
    this.mode = mode;
    this.el.modeMenu?.classList.remove('show');
    this.el.howTo?.classList.remove('show');
    this.el.scoreboard?.classList.toggle('hidden', mode !== '1v1');
    this.el.contestHud?.classList.toggle('show', mode === 'three-point');
    this.el.context?.classList.toggle('hidden', mode !== '1v1');
    if (mode === 'three-point') this.el.help?.classList.add('hidden');
  }

  hideContestOverlay() {
    this.el.contestOverlay?.classList.remove('show');
    this.el.contestOverlay?.classList.remove('setup');
    this.el.contestHud?.classList.remove('setup-mode');
    this.el.setupPanel?.classList.remove('show');
    this.el.moneyPanel?.classList.remove('show');
    this.el.cpuPanel?.classList.remove('show');
    this.el.eliminationPanel?.classList.remove('show');
    this.el.resultsPanel?.classList.remove('show');
  }

  showContestSetup(data) {
    this.hideContestOverlay();
    this.el.contestOverlay?.classList.add('show', 'setup');
    this.el.contestHud?.classList.add('setup-mode');
    this.el.setupPanel?.classList.add('show');
    if (this.el.setupTitle) this.el.setupTitle.textContent = 'HOW MANY PLAYERS?';
    if (this.el.setupCopy) {
      this.el.setupCopy.textContent = 'The first slots become P1–P4. Every open slot stays in the contest as CPU.';
    }
    if (this.el.playerCountOptions) this.el.playerCountOptions.hidden = false;
    if (this.el.characterOptions) this.el.characterOptions.hidden = false;
    for (const button of document.querySelectorAll('[data-player-count]')) {
      button.classList.toggle('selected', Number(button.dataset.playerCount) === data.playerCount);
    }
    for (const card of document.querySelectorAll('[data-character-index]')) {
      const index = Number(card.dataset.characterIndex);
      const assignment = data.assignments[index] ?? 'CPU';
      const local = assignment !== 'CPU';
      card.classList.toggle('local', local);
      card.classList.toggle('cpu', !local);
      const marker = card.querySelector('em');
      if (marker) marker.textContent = assignment;
    }
    if (this.el.setupHint) this.el.setupHint.textContent = '← / → PLAYERS · ENTER / A START';
  }

  showMoneyRack(selected, stage = 'first', profile = null) {
    this.hideContestOverlay();
    this.el.contestOverlay?.classList.add('show');
    this.el.moneyPanel?.classList.add('show');
    if (this.el.moneyPlayer) {
      const owner = profile?.playerLabel ? `${profile.playerLabel} · ${profile.name}` : 'YOUR ADVANTAGE';
      this.el.moneyPlayer.textContent = stage === 'final' ? `${owner} · FINAL SETUP` : owner;
      this.el.moneyPlayer.style.color = profile?.accent ?? '';
    }
    for (const button of document.querySelectorAll('[data-rack]')) {
      button.classList.toggle('selected', button.dataset.rack === selected);
    }
  }

  showCpuPrompt(profile, roundLabel) {
    this.hideContestOverlay();
    this.el.contestOverlay?.classList.add('show');
    this.el.cpuPanel?.classList.add('show');
    if (this.el.cpuName) this.el.cpuName.textContent = profile.name;
    if (this.el.cpuName) this.el.cpuName.style.color = profile.accent;
    if (this.el.cpuRound) this.el.cpuRound.textContent = roundLabel;
  }

  showContestResults(winner, standings) {
    this.hideContestOverlay();
    this.el.contestOverlay?.classList.add('show');
    this.el.resultsPanel?.classList.add('show');
    if (this.el.contestWinner) this.el.contestWinner.textContent = `${winner?.playerLabel ? `${winner.playerLabel} · ` : ''}${winner?.name ?? 'NO WINNER'} WINS`;
    if (this.el.finalRanking) {
      this.el.finalRanking.innerHTML = standings.map((entry, index) =>
        `<li class="${index === 0 ? 'champion' : 'eliminated'}"><span>${entry.playerLabel ? `${entry.playerLabel} · ` : ''}${entry.name}<small>${index === 0 ? 'CHAMPION' : 'ELIMINATED'}</small></span><b>${entry.score}${entry.tiebreakScore == null ? '' : ` · TB ${entry.tiebreakScore}`}</b></li>`).join('');
    }
  }

  showContestElimination({ rank, score, localResults = [], standings }) {
    this.hideContestOverlay();
    this.el.contestOverlay?.classList.add('show');
    this.el.eliminationPanel?.classList.add('show');
    if (this.el.eliminationTitle) {
      this.el.eliminationTitle.textContent = localResults.length > 1 ? 'LOCAL PLAYERS ELIMINATED' : `${localResults[0]?.name ?? 'VOLT'} ELIMINATED`;
    }
    if (this.el.eliminationCopy) {
      const lead = localResults.length > 1
        ? `Best local finish: ${localResults[0]?.playerLabel ?? ''} ${localResults[0]?.name ?? ''} at #${rank} with ${score} points.`
        : `${localResults[0]?.playerLabel ? `${localResults[0].playerLabel} · ` : ''}${localResults[0]?.name ?? 'VOLT'} finished #${rank} with ${score} points.`;
      this.el.eliminationCopy.textContent = `${lead} The top three advance to the Final.`;
    }
    if (this.el.eliminationRanking) {
      this.el.eliminationRanking.innerHTML = standings.map((entry, index) =>
        `<li class="${index < 3 ? 'advanced' : 'eliminated'}${entry.playerLabel ? ' volt' : ''}"><span>${index + 1}. ${entry.playerLabel ? `${entry.playerLabel} · ` : ''}${entry.name}<small>${index < 3 ? 'ADVANCED' : 'ELIMINATED'}</small></span><b>${entry.score}</b></li>`).join('');
    }
  }

  setContestRoadmap(roadmap) {
    if (!roadmap) return;
    const statusLabel = {
      live: 'LIVE', complete: 'FINAL', advanced: 'ADV', eliminated: 'OUT',
      tiebreak: 'TB', champion: 'CHAMP', pending: 'WAIT',
    };
    const renderEntry = (entry, index, placeholder = false) => {
      const status = entry?.status ?? 'pending';
      const name = entry?.name ?? `FINALIST ${index + 1}`;
      const score = entry?.score == null ? '—' : entry.score;
      const accent = entry?.accent ?? '#5ce6ed';
      const extra = entry?.tiebreakScore == null ? '' : `<em>TB ${entry.tiebreakScore}</em>`;
      const playerStatus = entry?.playerLabel ? `${entry.playerLabel} · ${statusLabel[status] ?? status.toUpperCase()}` : statusLabel[status] ?? status.toUpperCase();
      return `<li class="roadmap-entry ${status}${placeholder ? ' placeholder' : ''}" data-entrant="${entry?.entrantId ?? ''}" style="--entrant-accent:${accent}"><i></i><span><strong>${name}</strong><small>${playerStatus}</small></span><b>${score}${extra}</b></li>`;
    };
    if (this.el.contestRanking) {
      this.el.contestRanking.innerHTML = roadmap.first.map((entry, index) => renderEntry(entry, index)).join('');
    }
    if (this.el.contestFinalists) {
      this.el.contestFinalists.innerHTML = roadmap.final.map((entry, index) =>
        renderEntry(entry, index, !entry.entrantId)).join('');
    }
    if (this.el.contestRoadmapChampion) {
      const champion = roadmap.champion;
      this.el.contestRoadmapChampion.className = `roadmap-champion ${champion ? 'won' : 'pending'}`;
      this.el.contestRoadmapChampion.innerHTML = champion
        ? `<span class="roadmap-trophy">★</span><div><small>CHAMPION${champion.playerLabel ? ` · ${champion.playerLabel}` : ''}</small><strong>${champion.name}</strong></div><b>${champion.score}${champion.tiebreakScore == null ? '' : `<em>TB ${champion.tiebreakScore}</em>`}</b>`
        : '<span class="roadmap-trophy">★</span><div><small>CHAMPION</small><strong>TBD</strong></div><b>—</b>';
    }
    if (this.el.contestCutoff) this.el.contestCutoff.textContent = roadmap.label;
  }

  setContestHud(data) {
    if (!data || this.mode !== 'three-point') return;
    if (this.el.contestStage) this.el.contestStage.textContent = data.stage;
    if (this.el.contestEntrant) this.el.contestEntrant.textContent = data.entrant;
    if (this.el.contestClock) this.el.contestClock.textContent = Math.max(0, Math.ceil(data.clock));
    this.el.contestClockWrap?.classList.toggle('low', data.clock < 10.5);
    if (this.el.contestScore) this.el.contestScore.textContent = data.score;
    if (this.el.contestStation) this.el.contestStation.textContent = data.station;
    if (this.el.contestBallCount) this.el.contestBallCount.textContent = `BALL ${Math.max(1, data.attempt || 1)} / 27`;
    this.el.contestSkip?.classList.toggle('show', !!data.canSkipCpu && data.state !== 'cpu-prompt');

    if (this.el.contestAttempts) {
      this.el.contestAttempts.innerHTML = Array.from({ length: 27 }, (_, index) => {
        const attempt = data.attempts[index];
        const result = attempt?.resolved ? (attempt.made ? ' made' : ' miss') : '';
        const active = index === data.attempt - 1 && !attempt?.resolved ? ' active' : '';
        return `<i class="attempt-pip ${attempt?.kind ?? ''}${result}${active}" title="Ball ${index + 1}"></i>`;
      }).join('');
    }
    this.setContestRoadmap(data.roadmap);
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

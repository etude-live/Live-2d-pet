// 포모도로 타이머. 집중(work) → 휴식(break) 을 cycles 번, 마지막엔 긴 휴식(long).
// onPhase(phase, state): 단계가 바뀔 때 (캐릭터 대사·알림), onTick(state): 1초마다 (스트림덱·메뉴바 표시)
function createPomodoro({ onPhase, onTick }) {
  let st = { running: false, paused: false, phase: 'idle', endsAt: 0, left: 0, cycle: 0, cycles: 4, work: 25, brk: 5, long: 15 };
  let timer = null;

  const remaining = () => (st.paused ? st.left : Math.max(0, st.endsAt - Date.now()));
  const state = () => ({
    running: st.running, paused: st.paused, phase: st.phase,
    remainingSec: Math.ceil(remaining() / 1000),
    cycle: st.cycle, cycles: st.cycles,
    minutes: { work: st.work, break: st.brk, long: st.long }
  });

  function enter(phase) {
    st.phase = phase;
    const min = phase === 'work' ? st.work : phase === 'long' ? st.long : st.brk;
    st.endsAt = Date.now() + min * 60000;
    st.paused = false;
    onPhase?.(phase, state());
  }

  function tick() {
    if (!st.running) return;
    if (!st.paused && remaining() <= 0) next();
    onTick?.(state());
  }

  function next() {
    if (st.phase === 'work') {
      if (st.cycle >= st.cycles) enter('long');
      else enter('break');
    } else if (st.phase === 'long') {
      stop(true);
    } else {
      st.cycle += 1;
      enter('work');
    }
  }

  function start(opts = {}) {
    const n = (v, d, max) => (Number(v) > 0 ? Math.min(Number(v), max) : d);
    st = { ...st, running: true, paused: false, cycle: 1,
      work: n(opts.work, st.work, 180), brk: n(opts.break, st.brk, 60), long: n(opts.long, st.long, 120), cycles: n(opts.cycles, st.cycles, 12) };
    enter('work');
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    onTick?.(state());
    return state();
  }

  function stop(finished = false) {
    const was = st.running;
    st.running = false; st.paused = false; st.phase = 'idle';
    clearInterval(timer); timer = null;
    if (was) onPhase?.(finished ? 'done' : 'stopped', state());
    onTick?.(state());
    return state();
  }

  function pause() {
    if (!st.running) return state();
    if (st.paused) { st.endsAt = Date.now() + st.left; st.paused = false; onPhase?.('resumed', state()); }
    else { st.left = remaining(); st.paused = true; onPhase?.('paused', state()); }
    onTick?.(state());
    return state();
  }

  return {
    start, stop, pause,
    toggle: (opts) => (st.running ? stop() : start(opts)),
    skip: () => { if (st.running) { next(); onTick?.(state()); } return state(); },
    state
  };
}

module.exports = { createPomodoro };

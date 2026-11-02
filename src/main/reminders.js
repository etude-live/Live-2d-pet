// 알림 (한 번 / 매일). 캐릭터가 Claude 도구(set_reminder)로 맞추고, 시간이 되면 onFire(reminder) 를 부른다.
// 앱이 꺼져 있던 동안 지난 한 번짜리 알림은 다음에 켤 때 바로 알린다.
const fs = require('fs');

function nextDaily(hhmm, from = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function createReminders(file, onFire) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(list, null, 2)); } catch (e) { console.error('[reminders] 저장 실패:', e.message); } };
  let seq = list.reduce((m, r) => Math.max(m, r.id || 0), 0);

  function add({ message, minutes, at, daily }) {
    const text = String(message || '').trim().slice(0, 200);
    if (!text) throw new Error('알림 내용이 비어 있어요');
    let when;
    let dailyAt = null;
    if (daily) {
      if (!/^\d{1,2}:\d{2}$/.test(String(at || ''))) throw new Error('매일 알림은 at 에 "HH:MM" 을 주세요');
      dailyAt = String(at).padStart(5, '0');
      when = nextDaily(dailyAt);
    } else if (Number(minutes) > 0) {
      when = Date.now() + Number(minutes) * 60000;
    } else if (at) {
      if (/^\d{1,2}:\d{2}$/.test(String(at))) when = nextDaily(String(at).padStart(5, '0'));
      else when = new Date(at).getTime();
      if (!Number.isFinite(when)) throw new Error('시간을 알아볼 수 없어요');
    } else {
      throw new Error('minutes 나 at 중 하나가 필요해요');
    }
    const r = { id: ++seq, text, at: when, daily: dailyAt };
    list.push(r);
    save();
    return r;
  }

  function cancel(id) {
    const before = list.length;
    list = list.filter((r) => r.id !== Number(id));
    save();
    return list.length < before;
  }

  function tick() {
    const now = Date.now();
    let changed = false;
    for (const r of [...list]) {
      if (r.at > now) continue;
      try { onFire(r); } catch (e) { console.error('[reminders]', e); }
      if (r.daily) r.at = nextDaily(r.daily, now + 1000);
      else list = list.filter((x) => x !== r);
      changed = true;
    }
    if (changed) save();
  }
  setInterval(tick, 15000);
  setTimeout(tick, 5000);

  const describe = (r) => {
    const d = new Date(r.at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return r.daily ? `#${r.id} 매일 ${r.daily} — ${r.text}` : `#${r.id} ${d.getMonth() + 1}/${d.getDate()} ${hm} — ${r.text}`;
  };

  return { add, cancel, list: () => [...list].sort((a, b) => a.at - b.at), describe };
}

module.exports = { createReminders };

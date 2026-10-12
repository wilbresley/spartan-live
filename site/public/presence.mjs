export const OFFLINE_WAIT_MS = 90000;

export function nextPresence(state, names, stopped, now, waitMs = OFFLINE_WAIT_MS) {
  const primed = Boolean(state?.primed);
  const people = {};
  for (const [name, entry] of Object.entries(state?.people || {})) {
    people[name] = { offlineAt: entry?.offlineAt || 0 };
  }
  const live = new Set(names || []);
  const gone = new Set(stopped || []);
  const enter = [];
  const exit = [];
  for (const name of gone) {
    if (primed && people[name]) exit.push(name);
    delete people[name];
  }
  for (const name of Object.keys(people)) {
    if (live.has(name)) continue;
    if (!people[name].offlineAt) people[name] = { offlineAt: now };
    else if (now - people[name].offlineAt >= waitMs) {
      if (primed) exit.push(name);
      delete people[name];
    }
  }
  for (const name of live) {
    if (gone.has(name)) continue;
    const prev = people[name];
    if (!prev) {
      if (primed) enter.push(name);
      people[name] = { offlineAt: 0 };
    } else if (prev.offlineAt) {
      people[name] = { offlineAt: 0 };
    }
  }
  return { primed: true, people, enter, exit };
}

export const CHIME_GAP_MS = 180000;

export function freshArrivals(enter, known) {
  const have = new Set(known || []);
  return (enter || []).filter((name) => name && !have.has(name));
}

export function dueChimes(names, recent, now, gapMs = CHIME_GAP_MS) {
  const play = [];
  const next = { ...(recent || {}) };
  for (const name of names || []) {
    const last = next[name];
    if (last && now - last < gapMs) continue;
    play.push(name);
    next[name] = now;
  }
  return { play, recent: next };
}

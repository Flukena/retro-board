import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { WRITING_TIMER_PHASE, WRITING_TIMER_PRESET_MINUTES } from '../../domain/writing-timer.js';

const MODULE = '/src/client/writing-timer/WritingTimer.jsx';
const LANGUAGES = ['th', 'en'];
const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll("'", '&#x27;').replaceAll('"', '&quot;');
const RUNNING = Object.freeze({ phase: WRITING_TIMER_PHASE.RUNNING, remainingMs: 179_000, label: '02:59', urgent: false });
const IDLE = Object.freeze({ phase: WRITING_TIMER_PHASE.IDLE });
const TIMES_UP = Object.freeze({ phase: WRITING_TIMER_PHASE.TIMES_UP });

function fakeStore(view) {
  const calls = [];
  return {
    calls, view: () => view, takeExpiry: () => false, subscribe: () => () => {},
    start: (minutes) => calls.push(['start', minutes]), extend: () => calls.push(['extend']), stop: () => calls.push(['stop']),
  };
}
const render = (WritingTimer, view, isAdmin) => renderToStaticMarkup(
  React.createElement(WritingTimer, { isAdmin, store: fakeStore(view) }),
);
const buttonsIn = (element) => {
  const found = [];
  const walk = (node) => {
    if (!React.isValidElement(node)) return;
    if (node.type === 'button' || node.props.onClick) found.push(node);
    React.Children.forEach(node.props.children, walk);
  };
  walk(element);
  return found;
};

test('only an admin gets the start control; others see nothing until a timer runs', async () => {
  await withChromeModule(MODULE, ({ WritingTimer }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      assert.equal(render(WritingTimer, IDLE, false), '', `${lang}: no start control for a non-admin`);
      const html = render(WritingTimer, IDLE, true);
      assert.ok(html.includes(`aria-label="${escapeHtml(t('writingTimer.open'))}"`), `${lang}: start control`);
      assert.match(html, /aria-expanded="false"/);
      assert.doesNotMatch(html, /data-board-shortcuts/, 'the closed button leaves board shortcuts alone');
    }
  });
});

test('everyone sees the countdown; only an admin gets +1 and stop', async () => {
  await withChromeModule(MODULE, ({ WritingTimer }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const member = render(WritingTimer, RUNNING, false);
      assert.match(member, /class="rb-writing-timer"/);
      assert.match(member, /data-phase="running"/);
      assert.match(member, /role="timer"/);
      assert.ok(member.includes('02:59'));
      assert.ok(member.includes(`aria-label="${escapeHtml(t('writingTimer.left'))}"`), `${lang}: timer label`);
      assert.doesNotMatch(member, /<button/, `${lang}: no controls for a non-admin`);
      const admin = render(WritingTimer, RUNNING, true);
      assert.ok(admin.includes(escapeHtml(t('topbar.extend', { n: 1 }))), `${lang}: +1`);
      assert.ok(admin.includes(`aria-label="${escapeHtml(t('writingTimer.stop'))}"`), `${lang}: stop`);
    }
  });
});

test('the last stretch is marked urgent', async () => {
  await withChromeModule(MODULE, ({ WritingTimer }) => {
    assert.match(render(WritingTimer, { ...RUNNING, urgent: true, label: '00:20' }, false), /rb-writing-timer--urgent/);
  });
});

test("at the end everyone sees Time's up in their language, with no controls", async () => {
  await withChromeModule(MODULE, ({ WritingTimer }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      for (const isAdmin of [false, true]) {
        const html = render(WritingTimer, TIMES_UP, isAdmin);
        assert.match(html, /data-phase="timesUp"/);
        assert.ok(html.includes(escapeHtml(t('writingTimer.timesUp'))), `${lang}: time's up`);
        assert.doesNotMatch(html, /<button/);
      }
    }
    setLang('th');
    assert.equal(t('writingTimer.timesUp'), 'หมดเวลา');
    setLang('en');
    assert.equal(t('writingTimer.timesUp'), "Time's up");
  });
});

test('+1 and stop call the store', async () => {
  await withChromeModule(MODULE, ({ RunningTimer }) => {
    const store = fakeStore(RUNNING);
    buttonsIn(RunningTimer({ view: RUNNING, store, isAdmin: true })).forEach((button) => button.props.onClick());
    assert.deepEqual(store.calls, [['extend'], ['stop']]);
  });
});

test('the setup offers 3, 5 and 10 minutes, which start at once, and a custom value clamped to the timer range', async () => {
  await withChromeModule(MODULE, ({ WritingTimerSetup }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const started = [];
      const custom = [];
      const setup = WritingTimerSetup({ minutes: 7, onMinutes: (value) => custom.push(value), onStart: (minutes) => started.push(minutes) });
      const html = renderToStaticMarkup(setup);
      for (const minutes of WRITING_TIMER_PRESET_MINUTES) {
        assert.ok(html.includes(escapeHtml(t('writingTimer.minutes', { n: minutes }))), `${lang}: ${minutes}`);
      }
      assert.ok(html.includes(`aria-label="${escapeHtml(t('writingTimer.custom'))}"`), `${lang}: custom`);
      assert.match(html, /data-board-shortcuts="off"/, 'typing a custom value stays out of the board');
      assert.match(html, /min="1"/);
      assert.match(html, /max="120"/);
      buttonsIn(setup).forEach((button) => button.props.onClick());
      assert.deepEqual(started, [...WRITING_TIMER_PRESET_MINUTES, 7], 'each preset, then Start with the custom value');
      const input = (function find(node) {
        if (!React.isValidElement(node)) return null;
        if (node.type === 'input') return node;
        return React.Children.toArray(node.props.children).map(find).find(Boolean) ?? null;
      }(setup));
      input.props.onChange({ target: { value: '500' } });
      input.props.onChange({ target: { value: '' } });
      assert.deepEqual(custom, [120, 1], 'custom minutes clamp to 1-120');
    }
  });
});

test('without a board timer store (Public Wall, server render) nothing renders', async () => {
  await withChromeModule(MODULE, ({ WritingTimer }) => {
    assert.equal(renderToStaticMarkup(React.createElement(WritingTimer, { isAdmin: true, store: null })), '');
  });
});

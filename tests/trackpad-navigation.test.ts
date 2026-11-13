import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { trackpadNavigation, type HistoryDirection } from '../src/trackpad-navigation';

function setup(enabled = true) {
  const dom = new JSDOM('<div id="root"><div id="content"></div><input id="input"></div>');
  const root = dom.window.document.querySelector<HTMLElement>('#root')!;
  const content = dom.window.document.querySelector<HTMLElement>('#content')!;
  let time = 0;
  const directions: HistoryDirection[] = [];
  const feedback: { direction: HistoryDirection | null; progress: number }[] = [];
  const dispose = trackpadNavigation(root, {
    enabled: () => enabled,
    navigate: direction => directions.push(direction),
    feedback: (direction, progress) => feedback.push({ direction, progress }),
    now: () => time,
  });
  const wheel = (deltaX: number, deltaY = 0, target: HTMLElement = content) => {
    const event = new dom.window.WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event;
  };
  return { dom, root, content, directions, feedback, dispose, wheel, tick(ms: number) { time += ms; } };
}

test('horizontal trackpad swipes navigate native history once per gesture', () => {
  const f = setup();
  try {
    assert.equal(f.wheel(-45).defaultPrevented, true);
    assert.deepEqual(f.directions, []);
    f.tick(30); f.wheel(-45);
    assert.deepEqual(f.directions, ['back']);
    f.tick(30); f.wheel(-120);
    assert.deepEqual(f.directions, ['back'], 'momentum does not navigate twice');
    f.tick(1000); f.wheel(100);
    assert.deepEqual(f.directions, ['back', 'forward']);
  } finally { f.dispose(); f.dom.window.close(); }
});

test('edge feedback follows finger direction and brightness, then fades after the gesture', () => {
  const f = setup();
  try {
    f.wheel(-18);
    assert.deepEqual(f.feedback.at(-1), { direction: 'back', progress: 0.2 });
    f.tick(20); f.wheel(-36);
    assert.deepEqual(f.feedback.at(-1), { direction: 'back', progress: 0.6 });
    f.tick(20); f.wheel(-36);
    assert.deepEqual(f.feedback.at(-1), { direction: 'back', progress: 1 });
    assert.deepEqual(f.directions, ['back']);
    f.tick(30); f.wheel(-100);
    assert.deepEqual(f.feedback.at(-1), { direction: 'back', progress: 1 }, 'momentum keeps the completed glow visible');
    f.tick(200); f.wheel(0, 20);
    assert.deepEqual(f.feedback.at(-1), { direction: null, progress: 0 }, 'idle or vertical scrolling fades the glow');
    f.tick(1000); f.wheel(30);
    assert.deepEqual(f.feedback.at(-1), { direction: 'forward', progress: 1 / 3 });
    f.tick(20); f.wheel(60);
    assert.deepEqual(f.feedback.at(-1), { direction: 'forward', progress: 1 });
    f.dispose();
    assert.deepEqual(f.feedback.at(-1), { direction: null, progress: 0 }, 'view cleanup also clears feedback');
  } finally { f.dispose(); f.dom.window.close(); }
});

test('vertical scrolling, editing, horizontal scrollers and disabled gestures stay untouched', () => {
  const f = setup(false);
  try {
    assert.equal(f.wheel(-120).defaultPrevented, false, 'disabled setting');
    f.dispose();
  } finally { f.dom.window.close(); }
  const active = setup();
  try {
    assert.equal(active.wheel(10, 80).defaultPrevented, false, 'vertical intent');
    assert.equal(active.wheel(-120, 0, active.dom.window.document.querySelector<HTMLElement>('#input')!).defaultPrevented, false, 'editing');
    const scroller = active.dom.window.document.createElement('div'); scroller.style.overflowX = 'auto'; active.root.append(scroller);
    Object.defineProperties(scroller, { scrollWidth: { value: 500 }, clientWidth: { value: 200 } });
    assert.equal(active.wheel(-120, 0, scroller).defaultPrevented, false, 'horizontal content keeps its own scrolling');
    assert.deepEqual(active.directions, []);
    active.dispose(); active.wheel(-120);
    assert.deepEqual(active.directions, [], 'cleanup removes the listener');
  } finally { active.dom.window.close(); }
});

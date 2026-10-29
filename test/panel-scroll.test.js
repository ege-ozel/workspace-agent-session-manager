const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let resized, scrolled, top = 0;
  const observed = [];
  const follow = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/scroll.js'), 'utf8') + ';followConversation;', {
    ResizeObserver: class {
      constructor(callback) { resized = callback; }
      observe(node) { observed.push(node); }
    },
  });
  const chat = {
    scrollHeight: 3000, clientHeight: 500,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener(name, callback) { if (name === 'scroll') scrolled = callback; },
  };
  const contents = [{}, {}];
  const scroll = follow(chat, contents);
  return { chat, scroll, observed, contents, resize: () => resized(), readAt(value) { chat.scrollTop = value; scrolled(); } };
}

test('first render and incoming messages follow the bottom', () => {
  const { chat, scroll } = fixture();
  scroll.update(() => {});
  assert.equal(chat.scrollTop, 2500);
  scroll.update(() => { chat.scrollHeight += 1200; });
  assert.equal(chat.scrollTop, 3700);
});

test('reading older content survives appends, resets and late image growth', () => {
  const { chat, scroll, readAt, resize } = fixture();
  scroll.toBottom();
  readAt(1000);
  scroll.update(() => { chat.scrollHeight += 1000; });
  assert.equal(chat.scrollTop, 1000);
  chat.scrollHeight += 600;
  resize();
  assert.equal(chat.scrollTop, 1000);
  scroll.update(() => { chat.scrollHeight = 4000; });
  assert.equal(chat.scrollTop, 1000);
});

test('scrolling back near the bottom resumes following with a fixed threshold', () => {
  const { chat, scroll, readAt } = fixture();
  chat.scrollHeight = 100000;
  readAt(99000); // Within 1% of a long transcript, but still a screen away.
  scroll.update(() => { chat.scrollHeight += 100; });
  assert.equal(chat.scrollTop, 99000);
  readAt(chat.scrollHeight - chat.clientHeight - 48);
  scroll.update(() => { chat.scrollHeight += 100; });
  assert.equal(chat.scrollTop, chat.scrollHeight - chat.clientHeight);
});

test('late images and viewport changes follow only the current reading position', () => {
  const { chat, scroll, readAt, resize, observed, contents } = fixture();
  assert.deepEqual(observed, [chat, ...contents]);
  scroll.toBottom();
  chat.scrollHeight += 600;
  resize();
  assert.equal(chat.scrollTop, 3100);
  chat.clientHeight = 350;
  resize();
  assert.equal(chat.scrollTop, 3250);
  readAt(700); // The image request began at the bottom; its completion must not drag us back.
  chat.scrollHeight += 600;
  resize();
  assert.equal(chat.scrollTop, 700);
});

test('loading earlier messages preserves the reading position including the earlier button height', () => {
  const { chat, scroll, readAt, resize } = fixture();
  readAt(20);
  scroll.update(() => { chat.scrollHeight += 1000 - 40; }, true);
  assert.equal(chat.scrollTop, 980);
  resize();
  assert.equal(chat.scrollTop, 980);
});

test('explicitly returning to latest content enables following again', () => {
  const { chat, scroll, readAt, resize } = fixture();
  readAt(500);
  scroll.toBottom();
  chat.scrollHeight += 200;
  resize();
  assert.equal(chat.scrollTop, 2700);
});

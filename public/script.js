const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('message-input');

function addMessage(text, sender) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${sender}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  chatEl.appendChild(wrapper);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function showTyping() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message bot';
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing';
  wrapper.appendChild(bubble);
  chatEl.appendChild(wrapper);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrapper;
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const message = inputEl.value.trim();
  if (!message) return;

  addMessage(message, 'user');
  inputEl.value = '';
  formEl.querySelector('button').disabled = true;

  const typing = showTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const data = await response.json();

    typing.remove();
    if (!response.ok) {
      addMessage(`⚠️ ${data.error || 'Došlo je do greške.'}`, 'bot');
    } else {
      addMessage(data.reply, 'bot');
      if (Array.isArray(data.sources) && data.sources.length > 0) {
        addSources(data.sources);
      }
    }
  } catch (err) {
    typing.remove();
    addMessage('⚠️ Ne mogu da se povežem sa serverom. Da li je backend pokrenut?', 'bot');
  } finally {
    formEl.querySelector('button').disabled = false;
    inputEl.focus();
  }
});

function addSources(sources) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message bot sources';

  const box = document.createElement('div');
  box.className = 'bubble';
  box.innerHTML = '<strong>Izvori:</strong>';
  sources.slice(0, 5).forEach((url) => {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60);
    const br = document.createElement('br');
    box.appendChild(br);
    box.appendChild(link);
  });

  wrapper.appendChild(box);
  chatEl.appendChild(wrapper);
  chatEl.scrollTop = chatEl.scrollHeight;
}

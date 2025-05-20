require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// ✉️ Відправити повідомлення
async function sendMessage(chatId, text, extra = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  });
}

// 📸 Відправити фото адміну зі скріном і кнопками
async function sendPhotoToAdmin(userChatId, fileId, displayName) {
  const caption = `📥 Новий скріншот оплати від <b>${displayName}</b>\nchat_id: <code>${userChatId}</code>`;
  await axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: ADMIN_ID,
    photo: fileId,
    caption,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Прийняти', callback_data: `approve_${userChatId}` },
        { text: '❌ Відхилити', callback_data: `reject_${userChatId}` }
      ]]
    }
  });
}

// === Webhook endpoint ===
app.post('/', async (req, res) => {
  const data = req.body;
  const msg = data.message || data.callback_query?.message;
  const chatId = msg.chat.id;

  // 📷 Фото
  if (data.message?.photo) {
    const fileId = data.message.photo.pop().file_id;
    const name = data.message.chat.first_name || '';
    const username = data.message.chat.username ? `@${data.message.chat.username}` : '';
    const display = `${name} ${username}`.trim();
    await sendMessage(chatId, '✅ Скріншот отримано. Очікуй підтвердження.');
    await sendPhotoToAdmin(chatId, fileId, display);
    return res.send('ok');
  }

  // Кнопки approve/reject
  const callbackData = data.callback_query?.data;
  if (callbackData?.startsWith('approve_') || callbackData?.startsWith('reject_')) {
    const targetChatId = callbackData.split('_')[1];
    if (callbackData.startsWith('approve_')) {
      await sendMessage(targetChatId, '🎉 Оплату підтверджено! Ти в грі 🚀');
      await sendMessage(ADMIN_ID, `✅ Оплату підтверджено для <code>${targetChatId}</code>`, { parse_mode: 'HTML' });
    } else {
      await sendMessage(targetChatId, '⛔️ Скрін не пройшов перевірку. Спробуй ще раз або напиши нам.');
      await sendMessage(ADMIN_ID, `❌ Оплату відхилено для <code>${targetChatId}</code>`, { parse_mode: 'HTML' });
    }
    return res.send('ok');
  }

  res.send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));

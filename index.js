// index.js з try/catch для стабільності
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const {
  handleStart,
  handleGameAnswer,
  sendMessage,
  sendPhotoGroup,
  sendQuestion,
  sendResult,
  getUser,
  saveUser,
  updateUser,
  getStoredMessageId,
  sendAfterPaymentMessages,
  sendAfterPaymentFollowup,
  sendStartSubscription,
  markUserAsPending,
  isUserPending,
  removePendingUser,
  isCooldownPassed,
  escapeHTML,
  sendSticker,
  sendPhotoToAdmin,
  approvePayment,
  logError
} = require('./utils');

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/', async (req, res) => {
  const data = req.body;
  const msg = data.message || data.callback_query?.message;
  if (!msg || !msg.chat) return res.send('ok');

  const chatId = msg.chat.id;
  const text = data.message?.text;
  const callbackData = data.callback_query?.data;
  const callbackPrefix = callbackData?.split('_')[0];

  // === 🔘 approve/reject buttons
  if (callbackPrefix === 'approve' || callbackPrefix === 'reject') {
    try {
      const targetChatId = callbackData.split('_')[1];
      const { data: messages } = await supabase.from('admin_messages').select('*');
      const row = messages.find(row => String(row.chat_id) === String(targetChatId));
      const { data: userData } = await axios.get(`${TELEGRAM_API}/getChat?chat_id=${targetChatId}`);
      const firstName = userData?.result?.first_name || '';
      const username = userData?.result?.username ? `@${userData.result.username}` : '';
      const display = `${firstName} ${username}`.trim();
      if (!row) {
        await sendMessage(ADMIN_ID, `⚠️ Повторна дія або запис уже видалено.`);
        return res.send('ok');
      }

      await supabase.from('admin_messages').delete().eq('chat_id', targetChatId);

      if (callbackPrefix === 'approve') {
        await approvePayment(targetChatId);
        await removePendingUser(targetChatId);

        await sendMessage(ADMIN_ID, `✅ Оплату підтверджено для <code>${targetChatId}</code> (${escapeHTML(display)})`, { parse_mode: 'HTML' });

      } else {
        await removePendingUser(targetChatId);
        await sendMessage(targetChatId, '⛔️ Скрін не пройшов перевірку. Спробуй ще раз або напиши нам.');
        await sendMessage(ADMIN_ID, `❌ Оплату відхилено для користувача <code>${targetChatId}</code> (${escapeHTML(display)})`, { parse_mode: 'HTML' });

      }

      if (row.message_id) {
        await axios.post(`${TELEGRAM_API}/deleteMessage`, {
          chat_id: ADMIN_ID,
          message_id: row.message_id
        });
      }
    } catch (e) {
      console.error('❌ Approve/Reject error:', e);
    }
    return res.send('ok');
  }

  // === 🖼 ФОТО
  if (data.message?.photo) {
    try {
      const bestPhoto = data.message.photo.at(-1);
      const fileId = bestPhoto.file_id;
      const name = msg.chat.first_name || "";
      const username = msg.chat.username ? `@${msg.chat.username}` : chatId;
      const display = name || username;

      if (await isUserPending(chatId)) {
        await sendPhotoToAdmin(chatId, fileId, display);
        await sendMessage(chatId, '✅ Скріншот отримано. Очікуй підтвердження.');
      } else {
        await sendMessage(chatId, '⚠️ Схоже, що ти ще не натискала кнопку "Приєднатись до кімнати". Спробуй спочатку її.');
      }
    } catch (e) {
      console.error('❌ Photo error:', e);
    }
    return res.send('ok');
  }

  // === 🎭 Стікери
  if (msg.sticker) {
    try {
      const stickerId = msg.sticker.file_id;
      await sendMessage(chatId, `🎭 Отримано file_id стікера:\n\n<code>${escapeHTML(stickerId)}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('❌ Sticker error:', e);
    }
    return res.send('ok');
  }

  // === 🎧 Аудіо
  if (msg.audio || msg.voice) {
    try {
      const fileId = (msg.audio || msg.voice).file_id;
      await sendMessage(chatId, `🎧 Отримано file_id звуку:\n\n<code>${escapeHTML(fileId)}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('❌ Audio error:', e);
    }
    return res.send('ok');
  }

  // === 📎 PDF
  if (msg.document?.mime_type === 'application/pdf') {
    try {
      const fileId = msg.document.file_id;
      await sendMessage(chatId, `📎 Отримано PDF файл!\n\n<code>${escapeHTML(fileId)}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('❌ PDF error:', e);
    }
    return res.send('ok');
  }

  // === 🚀 /start
  if (text === '/start') {
    try {
      await handleStart(chatId);
    } catch (e) {
      console.error('❌ Start error:', e);
    }
    return res.send('ok');
  }

  // === 🎯 CALLBACK
  if (callbackData) {
    try {
      if (callbackData === 'start_game') {
        if (!(await isCooldownPassed(chatId, 'start_game', 2))) {
          await sendMessage(chatId, '⏳ Не так швидко');
          return res.send('ok');
        }
        await saveUser(chatId, 1, []);
        await sendQuestion(chatId, 1);
      }

      if (callbackData.startsWith('answer_')) {
        if (!(await isCooldownPassed(chatId, callbackData, 3))) {
          await sendMessage(chatId, '⏳ Не так швидко');
          return res.send('ok');
        }
        await handleGameAnswer(chatId, callbackData, data);
      }

      if (callbackData === 'after_payment_1') {
        await sendAfterPaymentMessages(chatId);
      }

      if (callbackData === 'start_payment_flow') {
        await sendAfterPaymentFollowup(chatId);
      }

      if (callbackData === 'start_subscription') {
        await markUserAsPending(chatId);
        await sendStartSubscription(chatId);
      }
    } catch (e) {
      console.error('❌ Callback error:', e);
    }
    return res.send('ok');
  }

  res.send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));

// utils.js
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = process.env.ADMIN_ID;

// ==== 📩 МЕСЕДЖІ ====
async function sendMessage(chatId, text, options = {}) {
    const payload = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
    };
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return res.data.result.message_id;
}

async function sendPhotoGroup(chatId, photoIds) {
    const media = photoIds.map(id => ({ type: 'photo', media: id }));
    await axios.post(`${TELEGRAM_API}/sendMediaGroup`, {
        chat_id: chatId,
        media
    });
}

async function sendSticker(chatId, sticker) {
    await axios.post(`${TELEGRAM_API}/sendSticker`, { chat_id: chatId, sticker });
}

async function sendDocument(chatId, fileId) {
    await axios.post(`${TELEGRAM_API}/sendDocument`, {
        chat_id: chatId,
        document: fileId
    });
}

async function handleStart(chatId) {
    const { data: welcomeData, error } = await supabase
        .from('welcome')
        .select('*')
        .limit(1)
        .single();

    if (error || !welcomeData) {
        console.error('Помилка Supabase:', error?.message || 'Порожня таблиця');
        await sendMessage(chatId, '⚠️ Сталася помилка. Спробуй пізніше.');
        return;
    }

    const { sticker_id, welcome_text_1, welcome_text_2 } = welcomeData;

    if (sticker_id) {
        await axios.post(`${TELEGRAM_API}/sendSticker`, {
            chat_id: chatId,
            sticker: sticker_id
        });
    }

    if (welcome_text_1) {
        await sendMessage(chatId, welcome_text_1);
    }

    if (welcome_text_2) {
        await sendMessage(chatId, welcome_text_2, {
            reply_markup: {
                inline_keyboard: [[{ text: '🎮 Розпочати гру', callback_data: 'start_game' }]]
            }
        });
    }
}

async function handleGameAnswer(chatId, callbackData, data) {
  const answer = parseInt(callbackData.split('_')[1], 10);
  const msgIdFromQuery = data.callback_query.message.message_id;
  const icon = ['☑️', '🟢', '🎯', '🧩', '📍', '⚡️', '🚀'][Math.floor(Math.random() * 7)];

  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: msgIdFromQuery,
    text: `${icon} Обрана відповідь ${answer}`,
    reply_markup: { inline_keyboard: [] }
  });

  const { data: userData } = await supabase.from('users').select('*').eq('chat_id', chatId).single();
  if (!userData || userData.finished || String(userData.message_id) !== String(msgIdFromQuery)) return;

  const answers = userData.answers?.split(',').map(Number) || [];
  answers[userData.step - 1] = answer;
  const nextStep = userData.step + 1;
  const finished = nextStep > 7;

  await supabase.from('users').update({
    step: finished ? userData.step : nextStep,
    answers: answers.join(','),
    finished
  }).eq('chat_id', chatId);

  if (finished) {
    await sendMessage(chatId, `🎮 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ 🎮`);
    await sendResult(chatId, answers);
  } else {
    await sendQuestion(chatId, nextStep);
  }
}

// ==== 🧠 ГРА ====
async function sendQuestion(chatId, number) {
  try {
    const { data, error } = await supabase.from('questions').select('*').eq('question_number', number).single();
    if (error || !data) throw new Error('⚠️ Запитання не знайдено.');

    await sendMessage(chatId, `Питання ${number}:

${data.question_text}`);

    const photos = [data.photo1_id, data.photo2_id, data.photo3_id, data.photo4_id, data.photo5_id, data.photo6_id].filter(Boolean);
    if (photos.length) await sendPhotoGroup(chatId, photos);

    const buttons = [
      [1, 2, 3].map(i => ({ text: `${i}`, callback_data: `answer_${i}` })),
      [4, 5, 6].map(i => ({ text: `${i}`, callback_data: `answer_${i}` }))
    ];
    const msgId = await sendMessage(chatId, '🧠 Обери той, що найкраще відображає тебе: 👇', {
      reply_markup: { inline_keyboard: buttons }
    });
    await supabase.from('users').update({ message_id: msgId }).eq('chat_id', chatId);
  } catch (e) {
    console.error('sendQuestion error:', e.message);
    await sendMessage(chatId, '⚠️ Сталася помилка з питанням.');
  }
}

async function sendResult(chatId, answers) {
    const counts = Array(6).fill(0);
    answers.forEach(a => counts[a - 1]++);

    const max = Math.max(...counts);
    const candidates = counts.map((c, i) => (c === max ? i + 1 : null)).filter(Boolean);
    const result = candidates[candidates.length - 1];
    const display = await getUserDisplay(chatId);
    await sendMessage(ADMIN_ID, `📊 Користувач <b>${escapeHTML(display)}</b> отримав результат <b>${result}</b>`, {
        parse_mode: 'HTML'
    });


    const { data, error } = await supabase
        .from('results')
        .select('*')
        .eq('result_number', result)
        .single();

    if (error || !data) {
        await sendMessage(chatId, '⚠️ Результат не знайдено.');
        return;
    }

    // Надсилаємо основний результат
    await sendMessage(chatId, data.text1);
    await sendMessage(chatId, data.text2);
    await sendDocument(chatId, data.pdf_id);

    // ⏱ Follow-up через 60 секунд у фоні
    setTimeout(async () => {
        try {
            const f = await supabase.from('followup').select('*').limit(1).single();
            if (f.data) {
                await sendMessage(chatId, f.data.message1);
                await sendMessage(chatId, f.data.message2);
            }

            await sendMessage(chatId, '🎭 Готова продовжити свою гру в новій реальності?', {
                reply_markup: {
                    inline_keyboard: [[{ text: '🧩 Що буде в цій грі:', callback_data: 'after_payment_1' }]]
                }
            });

            // Очищаємо користувача
            await supabase.from('users').delete().eq('chat_id', chatId);
        } catch (e) {
            console.error('❌ Помилка у follow-up:', e);
        }
    }, 60000); // 60 секунд

}


// ==== 🧾 ПІСЛЯ ОПЛАТИ ====
async function sendAfterPaymentMessages(chatId) {
    const { data, error } = await supabase
        .from('after_payment')
        .select('*')
        .order('order');

    if (error) {
        console.error('❌ Помилка Supabase:', error.message);
        await sendMessage(chatId, '⚠️ Сталася помилка при отриманні контенту. Спробуй пізніше.');
        return;
    }

    if (!Array.isArray(data)) {
        console.error('❌ Дані не є масивом:', data);
        await sendMessage(chatId, '⚠️ Не вдалося обробити дані. Спробуй пізніше.');
        return;
    }

    for (const row of data) {
        if (row.type === 'text') {
            if (row.content?.trim()) {
                await sendMessage(chatId, row.content);
            } else {
                console.warn('⚠️ Порожній текст для текстового блоку:', row);
            }
        }

        if (row.type === 'button') {
            if (row.content?.trim() && row.button_text?.trim()) {
                await sendMessage(chatId, row.content, {
                    reply_markup: {
                        inline_keyboard: [[{ text: row.button_text, callback_data: 'start_subscription' }]]
                    }
                });
            } else {
                console.warn('⚠️ Порожній контент або кнопка в button-блоці:', row);
            }
        }
    }
}

async function sendAfterPaymentFollowup(chatId) {
    const { data, error } = await supabase
        .from('after_payment_followup')
        .select('*')
        .order('order');

    if (error) {
        console.error('❌ Помилка Supabase (after_payment_followup):', error.message);
        await sendMessage(chatId, '⚠️ Сталася помилка. Спробуй пізніше.');
        return;
    }

    if (!Array.isArray(data)) {
        console.error('❌ Дані не є масивом (after_payment_followup):', data);
        await sendMessage(chatId, '⚠️ Не вдалося обробити дані.');
        return;
    }

    for (const row of data) {
        if (row.type === 'text' && row.content?.trim()) {
            await sendMessage(chatId, row.content);
        }

        if (row.type === 'button' && row.content?.trim() && row.button_text?.trim()) {
            await sendMessage(chatId, row.content, {
                reply_markup: {
                    inline_keyboard: [[{
                        text: row.button_text,
                        callback_data: 'start_payment_flow' // 👈 твій новий функціонал
                    }]]
                }
            });
        }
    }
}

async function approvePayment(chatId) {
    // 1️⃣ Додаємо у таблицю paid_users
    await supabase.from('paid_users').insert({ id: chatId });

    // 2️⃣ Надсилаємо повідомлення з кнопкою
    await sendMessage(chatId, '🎯 Оплату підтверджено! Переходь у наступну кімнату гри. 👇', {
        reply_markup: {
            inline_keyboard: [[
                { text: '👉 Перейти в другу кімнату гри', url: 'https://t.me/+9me2lhd12t00MGEy' }
            ]]
        }
    });
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await sendMessage(chatId, text, options);
    } catch (e) {
        console.error('sendMessage error:', e?.response?.data || e.message);
    }
}

async function getUserDisplay(chatId) {
    try {
        const { data: userData } = await axios.get(`${TELEGRAM_API}/getChat?chat_id=${chatId}`);
        const firstName = userData?.result?.first_name || '';
        const username = userData?.result?.username ? `@${userData.result.username}` : '';
        return `${firstName} ${username}`.trim();
    } catch (e) {
        console.error('❌ getUserDisplay error:', e?.response?.data || e.message);
        return chatId.toString(); // fallback
    }
}


async function sendStartSubscription(chatId) {
    const { data, error } = await supabase
        .from('after_payment_followup') // ✅ правильна таблиця
        .select('*')
        .order('order');

    const display = await getUserDisplay(chatId);
    await sendMessage(ADMIN_ID, `💳 Клієнт <b>${escapeHTML(display)}</b> перейшов до оплати`, {
        parse_mode: 'HTML'
    });

    if (error) {
        console.error('❌ Помилка Supabase (sendStartSubscription):', error.message);
        await sendMessage(chatId, '⚠️ Сталася помилка. Спробуй пізніше.');
        return;
    }

    if (!Array.isArray(data)) {
        console.error('❌ Дані не масив (sendStartSubscription):', data);
        await sendMessage(chatId, '⚠️ Дані не оброблені. Спробуй пізніше.');
        return;
    }

    for (const row of data) {
        if (row.type === 'text' && row.content?.trim()) {
            await sendMessage(chatId, row.content);
        }

        if (row.type === 'button' && row.content?.trim() && row.button_text?.trim()) {
            await sendMessage(chatId, row.content, {
                reply_markup: {
                    inline_keyboard: [[{
                        text: row.button_text,
                        callback_data: 'next_logic' // 🔁 можеш змінити на потрібну дію
                    }]]
                }
            });
        }
    }
}

async function sendPhotoToAdmin(chatId, fileId, displayName) {
    const caption = `📸 Новий скріншот від <b>${escapeHTML(displayName)}</b>\n<code>${chatId}</code>`;

    const response = await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: ADMIN_ID,
        photo: fileId,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Підтвердити', callback_data: `approve_${chatId}` },
                { text: '⛔️ Відхилити', callback_data: `reject_${chatId}` }
            ]]
        }
    });

    const messageId = response.data.result.message_id;

    // Зберігаємо, щоб можна було видалити пізніше
    await supabase.from('admin_messages').insert({
        chat_id: chatId,
        message_id: messageId
    });
}



// ==== 👤 КОРИСТУВАЧ ====
async function getUser(chatId) {
    const { data } = await supabase.from('users').select('*').eq('chat_id', chatId).single();
    if (!data) return { step: 1, answers: [] };
    const answers = data.answers?.split(',').map(n => parseInt(n)).filter(n => !isNaN(n)) || [];
    return { step: data.step, answers, finished: data.finished };
}

async function saveUser(chatId, step, answers) {
    await supabase.from('users').insert({ chat_id: chatId, step, answers: answers.join(','), finished: false });
}

async function updateUser(chatId, step, answers, finished = false) {
  await supabase.from('users').upsert({
    chat_id: chatId,
    step,
    answers: answers.join(','),
    finished
  }, { onConflict: ['chat_id'] });
}


async function getStoredMessageId(chatId) {
    const { data } = await supabase.from('users').select('message_id').eq('chat_id', chatId).single();
    return data?.message_id || null;
}

// ==== ПІДПИСКА ====
async function markUserAsPending(chatId) {
    const { data } = await supabase.from('pending').select('chat_id').eq('chat_id', chatId);
    if (!data?.length) await supabase.from('pending').insert({ chat_id: chatId });
}

async function isUserPending(chatId) {
    const { data } = await supabase.from('pending').select('*').eq('chat_id', chatId);
    return !!data?.length;
}

async function removePendingUser(chatId) {
    await supabase.from('pending').delete().eq('chat_id', chatId);
}

// ==== COOL DOWN ====
async function isCooldownPassed(chatId, action, cooldownSeconds) {
    const now = Date.now();
    const { data } = await supabase.from('cooldown').select('*').eq('chat_id', chatId).eq('action', action).maybeSingle();
    if (data) {
        const last = new Date(data.timestamp).getTime();
        if ((now - last) / 1000 < cooldownSeconds) return false;
        await supabase.from('cooldown').update({ timestamp: new Date().toISOString() }).eq('chat_id', chatId).eq('action', action);
        return true;
    } else {
        await supabase.from('cooldown').insert({ chat_id: chatId, action, timestamp: new Date().toISOString() });
        return true;
    }
}

// ==== HELPERS ====
function escapeHTML(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/`/g, '&#96;');
}

module.exports = {
    sendMessage,
    sendPhotoGroup,
    sendQuestion,
    sendResult,
    getUser,
    saveUser,
    updateUser,
    getStoredMessageId,
    sendAfterPaymentMessages,
    sendStartSubscription,
    markUserAsPending,
    isUserPending,
    removePendingUser,
    isCooldownPassed,
    safeSendMessage,
    escapeHTML,
    sendSticker,
    handleGameAnswer,
    getUserDisplay,
    sendPhotoToAdmin,
    approvePayment,
    sendAfterPaymentFollowup,
    handleStart
};

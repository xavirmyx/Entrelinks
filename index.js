const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// URL de la página de canales
const CHANNELS_URL = 'https://photocalltv.es/';

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com'; // ¡Reemplaza con tu URL real de Render!
  bot.setWebHook(`${webhookUrl}/bot${token}`)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer canales de la página
async function fetchChannels() {
  try {
    const { data } = await axios.get(CHANNELS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const channels = {
      nacionales: [],
      internacionales: [],
      deportes: [],
      radio: [],
    };

    // Extraer canales nacionales (ejemplo: sección "Nacionales")
    $('div#nacionales .channel').each((i, element) => {
      const name = $(element).find('img').attr('alt') || 'Canal desconocido';
      const link = $(element).find('a').attr('href');
      if (name && link) {
        channels.nacionales.push({ name, link: link.startsWith('http') ? link : `https://photocalltv.es${link}` });
      }
    });

    // Extraer canales internacionales (ejemplo: sección "Internacionales")
    $('div#internacionales .channel').each((i, element) => {
      const name = $(element).find('img').attr('alt') || 'Canal desconocido';
      const link = $(element).find('a').attr('href');
      if (name && link) {
        channels.internacionales.push({ name, link: link.startsWith('http') ? link : `https://photocalltv.es${link}` });
      }
    });

    // Extraer canales de deportes (ejemplo: sección "Deportes")
    $('div#deportes .channel').each((i, element) => {
      const name = $(element).find('img').attr('alt') || 'Canal desconocido';
      const link = $(element).find('a').attr('href');
      if (name && link) {
        channels.deportes.push({ name, link: link.startsWith('http') ? link : `https://photocalltv.es${link}` });
      }
    });

    // Extraer emisoras de radio (ejemplo: sección "Radio")
    $('div#radio .channel').each((i, element) => {
      const name = $(element).find('img').attr('alt') || 'Radio desconocida';
      const link = $(element).find('a').attr('href');
      if (name && link) {
        channels.radio.push({ name, link: link.startsWith('http') ? link : `https://photocalltv.es${link}` });
      }
    });

    console.log(`✅ Canales extraídos - Nacionales: ${channels.nacionales.length}, Internacionales: ${channels.internacionales.length}, Deportes: ${channels.deportes.length}, Radio: ${channels.radio.length}`);
    return channels;
  } catch (error) {
    console.error(`❌ Error al extraer canales: ${error.message}`);
    return { nacionales: [], internacionales: [], deportes: [], radio: [] };
  }
}

// Menú principal
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📺 Nacionales (España)', callback_data: 'nacionales' }],
        [{ text: '🌍 Internacionales', callback_data: 'internacionales' }],
        [{ text: '⚽ Deportes', callback_data: 'deportes' }],
        [{ text: '📻 Radio', callback_data: 'radio' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '📺 Bienvenido al Bot de TV en Vivo\nSelecciona una categoría:', options);
}

// Mostrar lista de canales
async function sendChannelList(chatId, category) {
  const channels = await fetchChannels();
  const channelList = channels[category];

  if (channelList.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No hay canales disponibles en ${category}.`);
    return;
  }

  const keyboard = channelList.map((channel, index) => [
    { text: channel.name, callback_data: `channel_${category}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
  await bot.sendMessage(chatId, `📺 Canales en ${category.charAt(0).toUpperCase() + category.slice(1)}:`, options);

  // Almacenar canales temporalmente
  bot.tempChannels = channels;
}

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /start recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /menu
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /menu recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /test (para depuración)
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /test recibido de ${chatId}`);
  bot.sendMessage(chatId, '✅ ¡El bot está vivo!');
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (['nacionales', 'internacionales', 'deportes', 'radio'].includes(data)) {
    await sendChannelList(chatId, data);
  } else if (data.startsWith('channel_')) {
    const [_, category, index] = data.split('_');
    const channel = bot.tempChannels[category][parseInt(index)];
    if (channel) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Volver al Menú', callback_data: 'back_to_menu' }],
          ],
        },
      };
      await bot.sendMessage(chatId, `📺 ${channel.name}\n🔗 [Ver en vivo](${channel.link})`, {
        parse_mode: 'Markdown',
        ...options,
      });
    }
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  }
});

console.log('🚀 Bot de TV en Vivo iniciado correctamente 🎉');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000; // Render usa process.env.PORT, por defecto 10000

// Middleware para parsear JSON
app.use(express.json());

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// Almacenar los canales en memoria
let channelsByCategory = {};

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para la raíz (/)
app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Función para cargar y organizar los canales desde teledirecto.es
async function loadChannels() {
  try {
    console.log('Intentando cargar canales desde: https://www.teledirecto.es/');
    const { data } = await axios.get('https://www.teledirecto.es/', { timeout: 15000 });
    const $ = cheerio.load(data);

    channelsByCategory = {
      espanoles: [],
      internacionales: [],
      deportes: [],
      infantiles: [],
      noticias: [],
      entretenimiento: [],
    };

    // Extraer los canales de las secciones relevantes
    $('a[href*="/directo/"]').each((index, element) => {
      const title = $(element).text().trim();
      const link = $(element).attr('href');
      if (!link || !title) return;

      const fullLink = link.startsWith('http') ? link : `https://www.teledirecto.es${link}`;

      const channel = { title, link: fullLink };

      // Clasificar los canales por categoría según el título o la sección
      if (title.toLowerCase().includes('deporte') || link.toLowerCase().includes('deporte')) {
        channelsByCategory.deportes.push(channel);
      } else if (title.toLowerCase().includes('infantil') || link.toLowerCase().includes('infantil')) {
        channelsByCategory.infantiles.push(channel);
      } else if (title.toLowerCase().includes('noticias') || link.toLowerCase().includes('noticias')) {
        channelsByCategory.noticias.push(channel);
      } else if (title.toLowerCase().includes('entretenimiento') || link.toLowerCase().includes('entretenimiento')) {
        channelsByCategory.entretenimiento.push(channel);
      } else if (
        title.toLowerCase().includes('france') ||
        title.toLowerCase().includes('italia') ||
        title.toLowerCase().includes('germany') ||
        title.toLowerCase().includes('japan') ||
        link.toLowerCase().includes('international')
      ) {
        channelsByCategory.internacionales.push(channel);
      } else {
        channelsByCategory.espanoles.push(channel); // Por defecto, asumimos que son canales españoles
      }
    });

    // Log de los canales cargados
    console.log(`✅ Canales cargados:`);
    console.log(`Españoles: ${channelsByCategory.espanoles.length}`);
    console.log(`Internacionales: ${channelsByCategory.internacionales.length}`);
    console.log(`Deportes: ${channelsByCategory.deportes.length}`);
    console.log(`Infantiles: ${channelsByCategory.infantiles.length}`);
    console.log(`Noticias: ${channelsByCategory.noticias.length}`);
    console.log(`Entretenimiento: ${channelsByCategory.entretenimiento.length}`);
  } catch (error) {
    console.error(`❌ Error al cargar canales: ${error.message}`);
  }
}

// Cargar los canales al iniciar el bot
loadChannels();

// Iniciar el servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);

  // Configurar el webhook
  await setWebhookWithRetry();
});

// Función para configurar el webhook con manejo de errores 429
async function setWebhookWithRetry() {
  try {
    console.log(`Configurando webhook: ${webhookUrl}/bot${token}`);
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`);
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429 Too Many Requests. Reintentando después de ${retryAfter} segundos...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry(); // Reintentar
    }
    console.error(`❌ Error al configurar webhook: ${error.message}`);
  }
}

// Menú principal con categorías
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  if (Object.keys(channelsByCategory).every(category => channelsByCategory[category].length === 0)) {
    await bot.sendMessage(chatId, '⚠️ No se pudieron cargar los canales. Intenta de nuevo más tarde.');
    return;
  }

  const keyboard = [];
  if (channelsByCategory.espanoles.length > 0) {
    keyboard.push([{ text: 'Españoles', callback_data: 'category_espanoles' }]);
  }
  if (channelsByCategory.internacionales.length > 0) {
    keyboard.push([{ text: 'Internacionales', callback_data: 'category_internacionales' }]);
  }
  if (channelsByCategory.deportes.length > 0) {
    keyboard.push([{ text: 'Deportes', callback_data: 'category_deportes' }]);
  }
  if (channelsByCategory.infantiles.length > 0) {
    keyboard.push([{ text: 'Infantiles', callback_data: 'category_infantiles' }]);
  }
  if (channelsByCategory.noticias.length > 0) {
    keyboard.push([{ text: 'Noticias', callback_data: 'category_noticias' }]);
  }
  if (channelsByCategory.entretenimiento.length > 0) {
    keyboard.push([{ text: 'Entretenimiento', callback_data: 'category_entretenimiento' }]);
  }
  keyboard.push([{ text: '🔍 Buscar', callback_data: 'search' }]);
  keyboard.push([{ text: 'ℹ️ Ayuda', callback_data: 'help' }]);

  const options = {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
  await bot.sendMessage(chatId, '📺 Bienvenido al Bot de Canales en Directo\nElige una categoría:', options);
}

// Mostrar canales de una categoría
async function sendCategoryChannels(chatId, category) {
  const channels = channelsByCategory[category];

  if (!channels || channels.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No hay canales en la categoría "${category}".`);
    return;
  }

  const keyboard = channels.slice(0, 20).map((channel, index) => [
    { text: channel.title, callback_data: `channel_${category}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `📋 Canales en "${category}":`, options);
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const results = [];
  for (const category in channelsByCategory) {
    const channels = channelsByCategory[category];
    channels.forEach((channel, index) => {
      if (channel.title.toLowerCase().includes(query.toLowerCase())) {
        results.push({ category, index, title: channel.title, link: channel.link });
      }
    });
  }

  if (results.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron resultados para "${query}".`);
    return;
  }

  const keyboard = results.slice(0, 20).map(result => [
    { text: result.title, callback_data: `channel_${result.category}_${result.index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🔍 Resultados para "${query}":`, options);
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

// Comando /buscar
bot.onText(/\/buscar (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];
  console.log(`📩 Comando /buscar recibido de ${chatId}: ${query}`);
  sendSearchResults(chatId, query);
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('category_')) {
    const category = data.replace('category_', '');
    await sendCategoryChannels(chatId, category);
  } else if (data.startsWith('channel_')) {
    const [_, category, index] = data.split('_');
    const channel = channelsByCategory[category][parseInt(index)];
    if (channel) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Volver', callback_data: `category_${category}` }],
          ],
        },
      };
      await bot.sendMessage(chatId, `📺 ${channel.title}\nReproduce aquí:\n${channel.link}`, options);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Usa /buscar <nombre> para encontrar un canal.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Instrucciones:\n- /start o /menu: Ver categorías.\n- /buscar <nombre>: Buscar canales.\n- Usa los botones para navegar.');
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');
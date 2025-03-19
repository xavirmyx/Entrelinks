const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Listas M3U predefinidas
const m3uLists = [
  {
    name: "CHUKYHOOD DEPORTES",
    image: "https://i.ibb.co/RbqRNzW/Chuky-Hood.jpg",
    url: "https://raw.githubusercontent.com/chukyvaliente/Chuky-Hood/main/Chuky-Hood"
  },
  {
    name: "CHUKYHOOD CINE",
    image: "https://i.ibb.co/vQJ9W7j/chuky.jpg",
    url: "https://raw.githubusercontent.com/chukyvaliente/chukycine/main/chukycine"
  }
];

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com'; // Manteniendo tu webhook de Render
bot.setWebHook(`${webhookUrl}/bot${token}`)
  .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
  .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));

// Función para extraer películas/canales de una lista M3U
async function fetchMoviesFromM3U(m3uUrl) {
  try {
    const { data } = await axios.get(m3uUrl, { timeout: 10000 });
    const lines = data.split('\n');
    const items = [];

    let currentItem = null;
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const titleMatch = line.match(/,(.+)/);
        if (titleMatch) {
          currentItem = { title: titleMatch[1].trim() };
        }
      } else if (line.startsWith('http') && currentItem) {
        currentItem.link = line.trim();
        items.push(currentItem);
        currentItem = null;
      }
    }

    console.log(`✅ Elementos extraídos de ${m3uUrl}: ${items.length}`);
    return items;
  } catch (error) {
    console.error(`❌ Error al extraer elementos de ${m3uUrl}: ${error.message}`);
    return [];
  }
}

// Menú principal con listas M3U
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const keyboard = m3uLists.map((list, index) => [
    { text: list.name, callback_data: `list_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔍 Buscar contenido', callback_data: 'search' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🎬 Bienvenido al Bot de Películas y Deportes M3U\nSelecciona una lista:', options);
}

// Mostrar contenido de una lista
async function sendContentList(chatId, listIndex) {
  const list = m3uLists[listIndex];
  const items = await fetchMoviesFromM3U(list.url);

  if (items.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se pudieron cargar elementos de "${list.name}".`);
    return;
  }

  const keyboard = items.slice(0, 20).map((item, index) => [
    { text: item.title, callback_data: `item_${listIndex}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Contenido en "${list.name}":`, options);

  bot.tempItems = bot.tempItems || {};
  bot.tempItems[listIndex] = items;
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const allItems = {};
  for (let i = 0; i < m3uLists.length; i++) {
    allItems[i] = await fetchMoviesFromM3U(m3uLists[i].url);
  }

  const results = [];
  for (const [listIndex, items] of Object.entries(allItems)) {
    items.forEach((item, itemIndex) => {
      if (item.title.toLowerCase().includes(query.toLowerCase())) {
        results.push({ listIndex: parseInt(listIndex), itemIndex, title: item.title, link: item.link });
      }
    });
  }

  if (results.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron resultados para "${query}".`);
    return;
  }

  const keyboard = results.slice(0, 20).map(result => [
    { text: result.title, callback_data: `item_${result.listIndex}_${result.itemIndex}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Resultados para "${query}":`, options);

  bot.tempItems = allItems;
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

// Comando /test
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /test recibido de ${chatId}`);
  bot.sendMessage(chatId, '✅ ¡El bot está vivo!');
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

  if (data.startsWith('list_')) {
    const listIndex = parseInt(data.split('_')[1]);
    await sendContentList(chatId, listIndex);
  } else if (data.startsWith('item_')) {
    const [_, listIndex, itemIndex] = data.split('_').map(Number);
    const item = bot.tempItems[listIndex][itemIndex];
    if (item) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
          ],
        },
      };
      // Enviar el enlace directamente para reproducción en Telegram
      await bot.sendMessage(chatId, `🎬 ${item.title}\nEnlace para reproducir:\n${item.link}`, options);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Escribe /buscar <nombre del contenido> para buscar.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Usa este bot para ver películas y deportes desde listas M3U:\n- /start o /menu: Ver listas.\n- /buscar <nombre>: Buscar contenido.\n- /test: Verificar estado.');
  }
});

console.log('🚀 Bot de Películas y Deportes M3U iniciado correctamente 🎉');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Listas .txt desde tu repositorio de GitHub
const contentLists = [
  {
    name: "DEPORTES",
    url: "https://raw.githubusercontent.com/xavirmyx/Entrelinks/main/ChukyDeport.txt"
  },
  {
    name: "PELÍCULAS",
    url: "https://raw.githubusercontent.com/xavirmyx/Entrelinks/main/ChukyHoodCines.txt"
  }
];

// Configuración del webhook (usando Render como indicaste)
const webhookUrl = 'https://entrelinks.onrender.com';
bot.setWebHook(`${webhookUrl}/bot${token}`)
  .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
  .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));

// Función para extraer contenido de un archivo .txt
async function fetchContentFromTxt(txtUrl) {
  try {
    const { data } = await axios.get(txtUrl, { timeout: 10000 });
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

    console.log(`✅ Elementos extraídos de ${txtUrl}: ${items.length}`);
    return items;
  } catch (error) {
    console.error(`❌ Error al extraer contenido de ${txtUrl}: ${error.message}`);
    return [];
  }
}

// Menú principal con listas
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const keyboard = contentLists.map((list, index) => [
    { text: list.name, callback_data: `list_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔍 Buscar', callback_data: 'search' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🎬 Bienvenido al Bot\nElige una categoría:', options);
}

// Mostrar contenido de una lista
async function sendContentList(chatId, listIndex) {
  const list = contentLists[listIndex];
  const items = await fetchContentFromTxt(list.url);

  if (items.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se pudo cargar contenido de "${list.name}".`);
    return;
  }

  const keyboard = items.slice(0, 20).map((item, index) => [
    { text: item.title, callback_data: `item_${listIndex}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `📋 Contenido en "${list.name}":`, options);

  bot.tempItems = bot.tempItems || {};
  bot.tempItems[listIndex] = items;
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const allItems = {};
  for (let i = 0; i < contentLists.length; i++) {
    allItems[i] = await fetchContentFromTxt(contentLists[i].url);
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
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🔍 Resultados para "${query}":`, options);

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
            [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
          ],
        },
      };
      // Enviar el enlace directamente para reproducción en Telegram
      await bot.sendMessage(chatId, `📺 ${item.title}\nReproduce aquí:\n${item.link}`, options);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Usa /buscar <nombre> para encontrar contenido.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Instrucciones:\n- /start o /menu: Ver categorías.\n- /buscar <nombre>: Buscar contenido.\n- Usa los botones para navegar.');
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');
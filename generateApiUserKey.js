const axios = require('axios');

// Datos para la solicitud
const apiDevKey = 'MrabyxYzAzEhoWXm6zftoXHAMe5GpKzs';
const username = 'EntreCopybot';
const password = 'z9Bz7y4#p95Tm4f';

// Función para generar el api_user_key
async function generateApiUserKey() {
  try {
    const response = await axios.post('https://pastebin.com/api/api_login.php', new URLSearchParams({
      api_dev_key: apiDevKey,
      api_user_name: username,
      api_user_password: password
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('Tu api_user_key es:', response.data);
  } catch (error) {
    console.error('Error al generar api_user_key:', error.response ? error.response.data : error.message);
  }
}

// Ejecutar la función
generateApiUserKey();
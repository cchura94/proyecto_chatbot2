const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require("@whiskeysockets/baileys");
const fs = require("fs")
const axios = require("axios")

require('dotenv').config()

const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('bd_chatbot2', 'root', '', {
    host: 'localhost',
    dialect: 'mysql'
});

async function testConexionBD(){
    try {
        await sequelize.authenticate();
        console.log('CONEXION CORRECTA CON BD.');
      } catch (error) {
        console.error('ERROR DE CONEXION CON BD:', error);
      }
}
testConexionBD();

const Contacto = sequelize.define(
    'Contacto',
    {
      // Model attributes are defined here
      nombre: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      nro_whatsapp: {
        type: DataTypes.STRING(50),
        allowNull: false,
        // allowNull defaults to true
      },
      saldo: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0
      }
    },
    {
      // Other model options go here
    },
  );

Contacto.sync({force: true})


const store = makeInMemoryStore({ })
// can be read from a file
store.readFromFile('./baileys_store.json')
// saves the state to a file every 10s
setInterval(() => {
    store.writeToFile('./baileys_store.json')
}, 10_000)


const userContexts = {}

async function conectarAWhatsapp(){

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    // Crear la conexion con Whatsapp
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        // syncFullHistory: true
    })

    store.bind(sock.ev)

    // Guardar el estado de autenticación
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('chats.upsert', () => {
        // can use "store.chats" however you want, even after the socket dies out
        // "chats" => a KeyedDB instance
        console.log('got chats', store.chats.all())
    })

    // Escuchar eventos de conexion
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
            // reconnect if not logged out
            if(shouldReconnect) {
                conectarAWhatsapp()
            }
        } else if(connection === 'open') {
            console.log('Conexion Abierta...')
        }
    });

    // escuchar Mensajes entrantes
    sock.ev.on('messages.upsert', async (m) => {
        console.log("Mensaje recibido: ", JSON.stringify(m, undefined, 2));

        const message = m.messages[0];
        if(message.key.fromMe && m.type != 'notify'){
            return;
        }

        const id = m.messages[0].key.remoteJid;
        const nombre = m.messages[0].pushName;
        const mensaje = m.messages[0].message?.conversation ||
                        m.messages[0].message?.extendedTextMessage?.text ||
                        m.messages[0].message?.text;

        
        if(!userContexts[id]){
            userContexts[id] = {menuActual: "main", lista_mensajes: []}
            enviarMenuPrincipal(sock, id, nombre);
            return;
        }

        let contacto = await Contacto.findOne({where: {nro_whatsapp: id}});
        if(!contacto){
            contacto = await Contacto.create(
                {
                  nombre: nombre,
                  nro_whatsapp: id
                }
              );
        }

        const menuActual = userContexts[id].menuActual;
        if(menuActual == "main"){
            switch (mensaje) {
                case "A":
                    if(contacto.saldo > 0){
                        await sock.sendMessage(id, {text: `Tienes deudas pendientes.\nTu Saldo pendiente a pagar es: ${contacto.saldo}`});
                    }else{
                        await sock.sendMessage(id, {text: `No Tienes deudas pendientes`});
                    }
                    break;
                case "B":
                    userContexts[id].menuActual = "soporte";
                    await sock.sendMessage(id, {text: `Ok, Seleccionaste opción B.\n\n- 👉 *1*: Problemas de autenticación\n- 👉 *2*: Direccion\n- 👉 *3*: Volver al Menú\n\n> Elija una opción`})
                    return
                    break;
                case "C":
                    userContexts[id].menuActual = "main";
                    enviarMenuPrincipal(sock, id, nombre);
                    return
                    break;
            
                default:
                    const respuestaIA = await obtenerRespuestaOpenAi(mensaje, id);
                    await sock.sendMessage(id, {text: respuestaIA});
                    break;
            }
        }else{
            switch (mensaje) {
                case "1":
                    await sock.sendMessage(id, {text: `Para resetear tu contraseña escribe al: +59173277937`})

                    break;
                case "2":
                    await sock.sendMessage(id, {text: "Nuestra dirección es: Av 123 Zona ABC o ingrese en google maps:"});

                        const sentMsg  = await sock.sendMessage(
                            id, 
                            { location: { degreesLatitude: 24.121231, degreesLongitude: 55.1121221 } }
                        )
                    break;
                case "3":
                    userContexts[id].menuActual = "main";
                    enviarMenuPrincipal(sock, id, nombre);
                    return
                break;
            
                default:
                    const respuestaIA = await obtenerRespuestaOpenAi(mensaje, id);
                    await sock.sendMessage(id, {text: respuestaIA});
                    break;
            }
        }

        
        
                        
    })

}

conectarAWhatsapp();

function sleep(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const lista_mensajes = []

async function obtenerRespuestaOpenAi(mensaje, user_id){
    console.log(userContexts);
    if(userContexts[user_id]?.lista_mensajes.length==0){
        userContexts[user_id].lista_mensajes = [
            {"role": "system", "content": [{type: "text", text: "Actua como un vendedor de equipos electronicos y no respondas temas diferentes, solamente responde en no más de 15 palabras"}]},
            {"role": "user", "content": [{type: "text", text: "cuales son los precios?"}]},
            {"role": "assistant", "content": [{type: "text", text: "solamente por ahora vendemos Teclados a un precio de 126.98 USD"}]},
        ];
    }
    // lista_mensajes.push({"role": "user", "content": [{type: "text", text: mensaje}]});
    userContexts[user_id]?.lista_mensajes.push({"role": "user", "content": [{type: "text", text: mensaje}]});

    const respuesta = await axios.post("https://api.openai.com/v1/chat/completions", {
        "model": "gpt-4o",
        "messages": userContexts[user_id]?.lista_mensajes
    },
    {
        headers: {
            Authorization: "Bearer "+process.env.KEY_TOKEN,
            "Content-Type": "application/json"
        }
    })
    console.log(respuesta.data.choices[0].message.content);
    // lista_mensajes.push({"role": "assistant", "content": [{type: "text", text: respuesta.data.choices[0].message.content}]});
    userContexts[user_id]?.lista_mensajes.push({"role": "assistant", "content": [{type: "text", text: respuesta.data.choices[0].message.content}]});

    return respuesta.data.choices[0].message.content;

}


/*
async function obtenerRespuestaOpenAi(mensaje){
    console.log(mensaje);

    lista_mensajes.push({"role": "user", "content": [{type: "text", text: mensaje}]});

    const respuesta = await axios.post("https://api.openai.com/v1/chat/completions", {
        "model": "gpt-4o",
        "messages": lista_mensajes
    },
    {
        headers: {
            Authorization: "Bearer TOKEN",
            "Content-Type": "application/json"
        }
    })
    console.log(respuesta.data.choices[0].message.content);
    lista_mensajes.push({"role": "assistant", "content": [{type: "text", text: respuesta.data.choices[0].message.content}]});

    return respuesta.data.choices[0].message.content;

}
*/

async function enviarMenuPrincipal(sock, id, nombre){
    await sock.sendMessage(id, {text: `Hola ${nombre}, Soy un Bot. Bienvenido\n*Consulta tus dudas:*\n\n- 👉 *A*: Consultar Deudas\n- 👉 *B*: Consulta Soporte\n- 👉 *C*: Volver al Menú\n\n> Elija una opción`})
}
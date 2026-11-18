require('dotenv').config();
const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
const EXCHANGE = 'estoque.eventos';
const FILAS = ['fila.auditoria', 'fila.compras', 'fila.vitrine'];

// Conecta e declara a topologia: exchange fanout + 3 filas duráveis ligadas a ela.
// Tanto a API quanto os workers chamam isso. Assim, mesmo que um worker nunca
// tenha sido iniciado (ou esteja desligado), a fila dele já existe e as
// mensagens ficam guardadas nela em vez de serem descartadas.
async function conectar() {
  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'fanout', { durable: true });
  for (const fila of FILAS) {
    await channel.assertQueue(fila, { durable: true });
    await channel.bindQueue(fila, EXCHANGE, '');
  }

  return { connection, channel };
}

// ---------------------------------------------------------------------
// PRODUTOR (usado pela API)
// ---------------------------------------------------------------------
let canalPublicador = null;

async function iniciarPublicador() {
  try {
    const { connection, channel } = await conectar();
    canalPublicador = channel;
    console.log('[rabbitmq] conectado, publicando em', EXCHANGE);

    connection.on('error', (err) => console.error('[rabbitmq] erro na conexão:', err.message));
    connection.on('close', () => {
      console.error('[rabbitmq] conexão fechada, tentando reconectar em 5s...');
      canalPublicador = null;
      setTimeout(iniciarPublicador, 5000);
    });
  } catch (err) {
    console.error('[rabbitmq] não foi possível conectar, tentando de novo em 5s:', err.message);
    setTimeout(iniciarPublicador, 5000);
  }
}

// Publica sem esperar nenhum consumidor. Nunca lança erro: se o broker estiver
// fora, só registra no log para a rota da API continuar respondendo.
function publicarEvento(evento) {
  if (!canalPublicador) {
    console.error('[rabbitmq] sem conexão, evento NÃO publicado:', JSON.stringify(evento));
    return false;
  }
  try {
    canalPublicador.publish(EXCHANGE, '', Buffer.from(JSON.stringify(evento)), {
      persistent: true, // mensagem gravada em disco pelo broker
      contentType: 'application/json',
      messageId: evento.eventoId,
    });
    return true;
  } catch (err) {
    console.error('[rabbitmq] falha ao publicar evento:', err.message, JSON.stringify(evento));
    return false;
  }
}

// ---------------------------------------------------------------------
// CONSUMIDOR (usado pelos workers)
// ---------------------------------------------------------------------
// `processar` é uma função async que recebe o evento. Se ela terminar sem erro,
// a mensagem recebe ack. Se der erro, a mensagem volta para a fila (nack com
// requeue) depois de 5s, para ser tentada de novo.
async function iniciarWorker(fila, processar) {
  const { connection, channel } = await conectar();
  await channel.prefetch(1); // uma mensagem por vez

  connection.on('close', () => {
    console.error(`[${fila}] conexão com o RabbitMQ perdida. Encerrando worker.`);
    process.exit(1);
  });

  console.log(`[${fila}] aguardando mensagens... (CTRL+C para sair)`);

  await channel.consume(
    fila,
    async (msg) => {
      if (!msg) return;

      let evento;
      try {
        evento = JSON.parse(msg.content.toString());
      } catch {
        console.error(`[${fila}] mensagem com JSON inválido, descartando.`);
        channel.nack(msg, false, false);
        return;
      }

      try {
        await processar(evento);
        channel.ack(msg); // só confirma depois que o Supabase respondeu OK
      } catch (err) {
        console.error(`[${fila}] erro no evento ${evento.eventoId}: ${err.message}. Devolvendo para a fila em 5s.`);
        setTimeout(() => channel.nack(msg, false, true), 5000);
      }
    },
    { noAck: false } // confirmação manual
  );
}

module.exports = { EXCHANGE, FILAS, conectar, iniciarPublicador, publicarEvento, iniciarWorker };

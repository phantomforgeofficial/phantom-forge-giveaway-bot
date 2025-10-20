import 'dotenv/config';
import express from 'express';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  Collection, EmbedBuilder, GatewayIntentBits, Partials,
  Routes, SlashCommandBuilder, REST
} from 'discord.js';
import {
  addGiveaway, getGiveaway, listGiveaways, updateGiveaway,
  getStatusMessageId, setStatusMessageId
} from './storage.js';

const PURPLE = 0x8000ff;
const SERVER_NAME = process.env.SERVER_NAME || 'Phantom Forge';
const LOGO_URL = process.env.LOGO_URL || null;
const STATUS_CHANNEL_ID = '1429121620194234478'; // fixed channel for status panel

/* ---------- Helpers ---------- */
function parseDuration(str) {
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let ms = 0, m;
  while ((m = re.exec(str))) {
    const v = +m[1]; const u = m[2].toLowerCase();
    if (u === 'd') ms += v * 86400000;
    if (u === 'h') ms += v * 3600000;
    if (u === 'm') ms += v * 60000;
    if (u === 's') ms += v * 1000;
  }
  return ms;
}
const pad = n => String(n).padStart(2, '0');
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
function humanEnds(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}
function pickWinners(arr, count) {
  const pool = [...new Set(arr)];
  const winners = [];
  while (winners.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(i, 1)[0]);
  }
  return winners;
}

/* ---------- Giveaway Embed ---------- */
function makeGiveawayEmbed({ prize, winners, endsAt, entriesCount, ended }) {
  const e = new EmbedBuilder()
    .setTitle('🎉 Phantom Forge Giveaway')
    .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}`)
    .setColor(PURPLE)
    .setTimestamp(new Date(endsAt))
    .setFooter({
      text: ended ? `${SERVER_NAME} • Giveaway ended` : `${SERVER_NAME} • Click the button to join`,
      iconURL: LOGO_URL || undefined
    });
  e.addFields(
    { name: '⏰ Ends in', value: ended ? '`Ended`' : `**${humanEnds(endsAt - Date.now())}**`, inline: true },
    { name: '👥 Entries', value: `**${entriesCount}**`, inline: true }
  );
  return e;
}
const joinId = id => `gw_join_${id}`;
const components = (id, ended) => ([
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(joinId(id))
      .setLabel(ended ? 'Ended' : 'Join / Leave')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!ended)
  )
]);

/* ---------- Status Embed ---------- */
function buildStatusEmbed() {
  const now = new Date();
  const uptime = fmtUptime(process.uptime() * 1000);
  const ping = Math.round(client.ws.ping);
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle('🕒 Phantom Forge Giveaway Bot Status')
    .addFields(
      { name: 'Active:', value: '✅ Online', inline: true },
      { name: 'Ping', value: `${ping} ms`, inline: true },
      { name: 'Uptime', value: '`' + uptime + '`', inline: false },
      { name: 'Last update', value: now.toLocaleString('en-US'), inline: false }
    )
    .setFooter({
      text: `Live updated every second | ${SERVER_NAME} • today at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
      iconURL: LOGO_URL || undefined
    });
}

/* ---------- Client Setup ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});
const participantCache = new Collection();

async function ensureStatusMessage() {
  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch) return null;
  const id = await getStatusMessageId();
  if (id) {
    const msg = await ch.messages.fetch(id).catch(() => null);
    if (msg) return msg;
  }
  const created = await ch.send({ embeds: [buildStatusEmbed()] });
  await setStatusMessageId(created.id);
  return created;
}
async function tickStatus() {
  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch) return;
  const id = await getStatusMessageId();
  const msg = id ? await ch.messages.fetch(id).catch(() => null) : await ensureStatusMessage();
  if (msg) await msg.edit({ embeds: [buildStatusEmbed()] }).catch(() => {});
}

/* ---------- Slash Commands ---------- */
const commands = [
  new SlashCommandBuilder()
    .setName('gstart').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('duration').setDescription('e.g., 1h30m, 45m, 2d').setRequired(true))
    .addStringOption(o => o.setName('prize').setDescription('Prize name').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('gend').setDescription('End a giveaway early')
    .addStringOption(o => o.setName('message_id').setDescription('Message ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('greroll').setDescription('Reroll winners')
    .addStringOption(o => o.setName('message_id').setDescription('Message ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('glist').setDescription('List active giveaways')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const { CLIENT_ID, GUILD_ID } = process.env;
  if (GUILD_ID)
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  else
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

/* ---------- Giveaway Handling ---------- */
async function endGiveaway(gw, { announce = true, reroll = false } = {}) {
  const guild = await client.guilds.fetch(gw.guildId);
  const ch = await guild.channels.fetch(gw.channelId);
  const msg = await ch.messages.fetch(gw.messageId).catch(() => null);

  const participants = [...new Set([
    ...gw.participants,
    ...(participantCache.get(gw.id) ? Array.from(participantCache.get(gw.id)) : [])
  ])];
  const winners = pickWinners(participants, gw.winners);
  await updateGiveaway(gw.id, { ended: true, winnersPicked: winners });

  const endedEmbed = makeGiveawayEmbed({
    prize: gw.prize, winners: gw.winners, endsAt: gw.endsAt,
    entriesCount: participants.length, ended: true
  });
  if (msg) await msg.edit({ embeds: [endedEmbed], components: components(gw.id, true) });

  if (!announce) return;
  if (winners.length)
    await ch.send(`🎉 **Giveaway ended!** Winners of **${gw.prize}**: ${winners.map(x => `<@${x}>`).join(', ')}\nCreate a ticket to claim your price!`);
  else
    await ch.send(`😕 No valid entries for **${gw.prize}**.`);
}

async function updateGiveaways() {
  const active = await listGiveaways({ ended: false });
  for (const gw of active) {
    try {
      const guild = await client.guilds.fetch(gw.guildId);
      const ch = await guild.channels.fetch(gw.channelId);
      if (!ch) continue;
      const msg = await ch.messages.fetch(gw.messageId);
      const entries = participantCache.get(gw.id)?.size ?? gw.participants.length;
      if (Date.now() >= gw.endsAt) { await endGiveaway(gw, { announce: true }); continue; }
      await msg.edit({
        embeds: [makeGiveawayEmbed({ prize: gw.prize, winners: gw.winners, endsAt: gw.endsAt, entriesCount: entries, ended: false })],
        components: components(gw.id, false)
      });
    } catch { /* ignore */ }
  }
}

/* ---------- Events ---------- */
client.on('interactionCreate', async i => {
  if (i.isChatInputCommand()) {
    if (i.commandName === 'gstart') {
      const dur = parseDuration(i.options.getString('duration', true));
      const prize = i.options.getString('prize', true);
      const winners = i.options.getInteger('winners') ?? 1;
      if (!dur) return i.reply({ content: 'Invalid duration format.', ephemeral: true });

      const endsAt = Date.now() + dur;
      const msg = await i.channel.send({
        embeds: [makeGiveawayEmbed({ prize, winners, endsAt, entriesCount: 0, ended: false })],
        components: components('temp', false)
      });
      const gw = {
        id: msg.id, messageId: msg.id, channelId: msg.channel.id, guildId: i.guildId,
        prize, winners, createdAt: Date.now(), endsAt, participants: [], ended: false, winnersPicked: []
      };
      await msg.edit({ components: components(gw.id, false) });
      await addGiveaway(gw);
      participantCache.set(gw.id, new Set());
      i.reply({ content: `Giveaway started for **${prize}**, ends in **${humanEnds(dur)}**.`, ephemeral: true });
    }
    if (i.commandName === 'gend') {
      const id = i.options.getString('message_id', true);
      const gw = await getGiveaway(id);
      if (!gw) return i.reply({ content: 'Not found.', ephemeral: true });
      await updateGiveaway(gw.id, { endsAt: Date.now() });
      await endGiveaway({ ...gw, endsAt: Date.now() }, { announce: true });
      return i.reply({ content: 'Giveaway ended.', ephemeral: true });
    }
    if (i.commandName === 'greroll') {
      const id = i.options.getString('message_id', true);
      const gw = await getGiveaway(id);
      if (!gw || !gw.ended) return i.reply({ content: 'Not found or not ended.', ephemeral: true });
      const winners = pickWinners(gw.participants, gw.winners);
      await updateGiveaway(gw.id, { winnersPicked: winners });
      await endGiveaway(gw, { announce: true, reroll: true });
      return i.reply({ content: 'Reroll done.', ephemeral: true });
    }
    if (i.commandName === 'glist') {
      const active = await listGiveaways({ ended: false });
      if (!active.length) return i.reply({ content: 'No active giveaways.', ephemeral: true });
      i.reply({ content: active.map(g => `• **${g.prize}** — ends in \`${humanEnds(g.endsAt - Date.now())}\``).join('\n'), ephemeral: true });
    }
  }
  if (i.isButton() && i.customId.startsWith('gw_join_')) {
    const id = i.customId.slice(8);
    const gw = await getGiveaway(id);
    if (!gw || gw.ended) return i.reply({ content: 'This giveaway has ended.', ephemeral: true });
    const set = participantCache.get(gw.id) ?? new Set(gw.participants);
    if (set.has(i.user.id)) { set.delete(i.user.id); i.reply({ content: 'You left the giveaway.', ephemeral: true }); }
    else { set.add(i.user.id); i.reply({ content: '🎉 You joined the giveaway! 🎉', ephemeral: true }); }
    participantCache.set(gw.id, set);
    await updateGiveaway(gw.id, { participants: Array.from(set) });
  }
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  await ensureStatusMessage();
  setInterval(tickStatus, 1000);
  setInterval(updateGiveaways, 5000);
});

/* ---------- Express for health ---------- */
const app = express();
app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Health endpoint active'));

/* ---------- Start ---------- */
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);

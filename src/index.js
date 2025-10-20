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

/* === THEME / BRANDING === */
const PURPLE = 0x8000ff;
const SERVER_NAME = process.env.SERVER_NAME || 'Phantom Forge';
const LOGO_URL = process.env.LOGO_URL || null;

/* === FIXED STATUS CHANNEL === */
const STATUS_CHANNEL_ID = '1429121620194234478'; // always post status here

/* === OPTIONAL DEFAULT GIVEAWAY CHANNEL (for /gstart) === */
const DEFAULT_CHANNEL_ID = process.env.DEFAULT_CHANNEL_ID || null;

/* ---------- Helpers ---------- */
function parseDuration(str) {
  const re = /(\d+)\s*(d|h|m|s)/gi; let ms = 0, m;
  while ((m = re.exec(str))) {
    const v = +m[1]; const u = m[2].toLowerCase();
    if (u === 'd') ms += v * 86400000;
    if (u === 'h') ms += v * 3600000;
    if (u === 'm') ms += v * 60000;
    if (u === 's') ms += v * 1000;
  }
  return ms;
}

function fmtDelta(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function humanEnds(ms) {
  // for short “Ends in” style (still used in giveaways)
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

/* ---------- Giveaway Embeds ---------- */
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

  const entriesField = { name: '👥 Entries', value: `**${entriesCount}**`, inline: true };
  if (!ended) {
    e.addFields(
      { name: '⏰ Ends in', value: `**${humanEnds(endsAt - Date.now())}**`, inline: true },
      entriesField
    );
  } else {
    e.addFields(entriesField);
  }
  return e;
}

const joinId = id => `gw_join_${id}`;
const components = (id, ended) => ([
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(joinId(id))
      .setLabel(ended ? 'Ended' : 'Join / Leave')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Secondary) // closest to purple
      .setDisabled(!!ended)
  )
]);

/* ---------- Discord Client ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.Channel] });
const participantCache = new Collection();

/* ---------- Slash Commands ---------- */
const commandData = [
  new SlashCommandBuilder()
    .setName('gstart').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('duration').setDescription('e.g., 1h30m, 45m, 2d').setRequired(true))
    .addStringOption(o => o.setName('prize').setDescription('Prize name').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the giveaway').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder()
    .setName('gend').setDescription('End a giveaway early')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('greroll').setDescription('Reroll the winners of a giveaway')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('glist').setDescription('Show all active giveaways')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const { CLIENT_ID, GUILD_ID } = process.env;
  if (!CLIENT_ID) throw new Error('CLIENT_ID missing in .env');
  if (GUILD_ID)
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandData });
  else
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandData });
}

/* ---------- Presence ---------- */
function setWatching() {
  const g = client.guilds.cache.first();
  client.user?.setPresence({ activities: [{ name: g?.name || SERVER_NAME, type: 3 }], status: 'online' });
}

/* ---------- STATUS PANEL (edit same message each second) ---------- */
function buildStatusEmbed() {
  const now = new Date();
  const uptime = fmtDelta(process.uptime() * 1000);
  const ping = Math.max(0, Math.round(client.ws.ping)) || 0;
  const e = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle('🕒 Phantom Forge Giveaway Bot Status')
    .setDescription('')
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
  return e;
}

async function ensureStatusMessage() {
  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;

  const existingId = await getStatusMessageId();
  if (existingId) {
    const msg = await channel.messages.fetch(existingId).catch(() => null);
    if (msg) return msg;
  }

  // Create once and remember its ID
  const created = await channel.send({ embeds: [buildStatusEmbed()] });
  await setStatusMessageId(created.id);
  return created;
}

async function tickStatus() {
  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const id = await getStatusMessageId();
  let msg = id ? await channel.messages.fetch(id).catch(() => null) : null;
  if (!msg) msg = await ensureStatusMessage();

  if (msg) {
    await msg.edit({ embeds: [buildStatusEmbed()] }).catch(() => {});
  }
}

/* ---------- Giveaway Updater ---------- */
async function updateGiveaways() {
  const active = await listGiveaways({ ended: false });
  for (const gw of active) {
    try {
      const guild = await client.guilds.fetch(gw.guildId);
      const channel = await guild.channels.fetch(gw.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) continue;

      const msg = await channel.messages.fetch(gw.messageId);
      const entries = participantCache.get(gw.id)?.size ?? gw.participants.length;

      if (Date.now() >= gw.endsAt) { await endGiveaway(gw, { announce: true }); continue; }

      await msg.edit({
        embeds: [makeGiveawayEmbed({
          prize: gw.prize, winners: gw.winners, endsAt: gw.endsAt, entriesCount: entries, ended: false
        })],
        components: components(gw.id, false)
      });
    } catch { /* ignore */ }
  }
}

async function endGiveaway(gw, { announce = true, reroll = false } = {}) {
  const guild = await client.guilds.fetch(gw.guildId);
  const channel = await guild.channels.fetch(gw.channelId);
  const message = await channel.messages.fetch(gw.messageId).catch(() => null);

  const participants = [
    ...new Set([
      ...gw.participants,
      ...(participantCache.get(gw.id) ? Array.from(participantCache.get(gw.id)) : [])
    ])
  ];

  const winners = pickWinners(participants, gw.winners);
  await updateGiveaway(gw.id, { ended: true, winnersPicked: winners });

  const endedEmbed = makeGiveawayEmbed({
    prize: gw.prize, winners: gw.winners, endsAt: gw.endsAt,
    entriesCount: participants.length, ended: true
  });

  if (message) await message.edit({ embeds: [endedEmbed], components: components(gw.id, true) });

  if (!announce) return;
  if (winners.length) {
    const mentions = winners.map(id => `<@${id}>`).join(', ');
    await channel.send({
      content: reroll
        ? `🔁 **Reroll!** New winners for **${gw.prize}**: ${mentions}`
        : `🎉 **Giveaway ended!** Winners of **${gw.prize}**: ${mentions}\nCreate a ticket to claim your price!`
    });
  } else {
    await channel.send(`😕 No valid entries for **${gw.prize}**.`);
  }
}

/* ---------- Interactions ---------- */
client.on('interactionCreate', async (i) => {
  if (i.isChatInputCommand()) {
    if (i.commandName === 'gstart') {
      const durStr = i.options.getString('duration', true);
      const prize = i.options.getString('prize', true);
      const winners = i.options.getInteger('winners') ?? 1;

      const ms = parseDuration(durStr);
      if (!ms || ms < 5000) return i.reply({ content: 'Invalid duration (e.g., 45m, 1h30m, 2d).', ephemeral: true });

      let target = i.options.getChannel('channel') || i.channel;
      if (DEFAULT_CHANNEL_ID) {
        const g = await client.guilds.fetch(i.guildId);
        target = await g.channels.fetch(DEFAULT_CHANNEL_ID) || target;
      }
      if (target.type !== ChannelType.GuildText) {
        return i.reply({ content: 'Please choose a text channel.', ephemeral: true });
      }

      const endsAt = Date.now() + ms;
      const msg = await target.send({
        embeds: [makeGiveawayEmbed({ prize, winners, endsAt, entriesCount: 0, ended: false })],
        components: components('temp', false)
      });

      const gw = {
        id: msg.id, messageId: msg.id, channelId: target.id, guildId: i.guildId,
        prize, winners, createdAt: Date.now(), endsAt, participants: [],
        ended: false, winnersPicked: []
      };

      await msg.edit({ components: components(gw.id, false) });
      await addGiveaway(gw);
      participantCache.set(gw.id, new Set());

      await i.reply({ content: `Giveaway started in <#${target.id}> for **${prize}**. Ends in **${humanEnds(ms)}**.`, ephemeral: true });
    }

    if (i.commandName === 'gend') {
      const id = i.options.getString('message_id', true);
      const gw = await getGiveaway(id);
      if (!gw) return i.reply({ content: 'Giveaway not found.', ephemeral: true });
      if (gw.ended) return i.reply({ content: 'Giveaway already ended.', ephemeral: true });

      await updateGiveaway(gw.id, { endsAt: Date.now() });
      await endGiveaway({ ...gw, endsAt: Date.now() }, { announce: true });
      return i.reply({ content: 'Giveaway ended.', ephemeral: true });
    }

    if (i.commandName === 'greroll') {
      const id = i.options.getString('message_id', true);
      const gw = await getGiveaway(id);
      if (!gw) return i.reply({ content: 'Giveaway not found.', ephemeral: true });
      if (!gw.ended) return i.reply({ content: 'Giveaway is still active.', ephemeral: true });

      const winners = pickWinners(gw.participants, gw.winners);
      await updateGiveaway(gw.id, { winnersPicked: winners });
      await endGiveaway(gw, { announce: true, reroll: true });
      return i.reply({ content: 'Reroll complete.', ephemeral: true });
    }

    if (i.commandName === 'glist') {
      const active = await listGiveaways({ ended: false });
      if (!active.length) return i.reply({ content: 'No active giveaways.', ephemeral: true });
      const lines = active.map(g => `• **${g.prize}** — ends in \`${humanEnds(g.endsAt - Date.now())}\` (<#${g.channelId}>)`);
      return i.reply({ content: lines.join('\n'), ephemeral: true });
    }
  }

  if (i.isButton() && i.customId.startsWith('gw_join_')) {
    const id = i.customId.replace('gw_join_', '');
    const gw = await getGiveaway(id);
    if (!gw) return i.reply({ content: 'This giveaway no longer exists.', ephemeral: true });
    if (gw.ended || Date.now() >= gw.endsAt) return i.reply({ content: 'This giveaway has ended.', ephemeral: true });

    const set = participantCache.get(gw.id) ?? new Set(gw.participants);
    if (set.has(i.user.id)) {
      set.delete(i.user.id);
      await updateGiveaway(gw.id, { participants: Array.from(set) });
      participantCache.set(gw.id, set);
      return i.reply({ content: 'You **left** the giveaway.', ephemeral: true });
    } else {
      set.add(i.user.id);
      await updateGiveaway(gw.id, { participants: Array.from(set) });
      participantCache.set(gw.id, set);
      return i.reply({ content: '🎉 You **joined** the giveaway! Good luck! 🎉', ephemeral: true });
    }
  }
});

/* ---------- Ready ---------- */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  setWatching();

  // hydrate cache
  const active = await listGiveaways({ ended: false });
  for (const gw of active) participantCache.set(gw.id, new Set(gw.participants));

  // ensure the status panel exists and start 1s updates
  await ensureStatusMessage();
  setInterval(tickStatus, 1000);

  // giveaways refresh (5s is enough)
  setInterval(updateGiveaways, 5000);
});

/* ---------- Express health ---------- */
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Health endpoint running'));

/* ---------- Boot ---------- */
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);

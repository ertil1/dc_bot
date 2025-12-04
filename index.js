import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from "@discordjs/voice";

import { exec } from "child_process";
import fs from "fs";
import path from "path";

// ===============================
//   AYARLAR (.env ÜZERİNDEN)
// ===============================
const TOKEN = process.env.DISCORD_TOKEN;
const N8N_DEFAULT_CHANNEL = process.env.CHANNEL_ID_N8N;
const PORT = process.env.PORT || 3000;

const PREFIX = "!";
const AUTO_ROLE_NAME = "Çaylak";
const LOG_CHANNEL_NAME = "📜・log";
const TICKET_CATEGORY_NAME = "🎫 TICKETLER";

// Güvenlik: token yoksa direkt çıksın
if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN .env içinde tanımlı değil!");
  process.exit(1);
}

// ===============================
//   MÜZİK SİSTEMİ – GLOBAL
// ===============================
let queue = []; // { url, title }
let connection = null;
let player = null;
let currentChannel = null;

// debug: tüm connection / player olaylarını logla
function attachDebug(connectionLocal, playerLocal) {
  try {
    connectionLocal.on("stateChange", (oldState, newState) => {
      console.log(
        "[VoiceConnection] stateChange",
        oldState.status,
        "->",
        newState.status
      );
    });
    connectionLocal.on("error", (err) => console.error("[VoiceConnection] error:", err));
  } catch (e) {}

  try {
    if (playerLocal) {
      playerLocal.on("stateChange", (oldState, newState) => {
        console.log("[AudioPlayer] stateChange", oldState.status, "->", newState.status);
      });
      playerLocal.on("error", (err) => console.error("[AudioPlayer] error:", err));
      playerLocal.on("debug", (d) => console.log("[AudioPlayer] debug:", d));
    }
  } catch (e) {}
}

// ====== Basit playMusic (yerel dosya testi) ======
async function playMusic(guild, textChannel) {
  if (!queue.length) {
    textChannel.send("🎶 Kuyruk boş, ses kanalından çıkıyorum.");
    if (connection) connection.destroy();
    connection = null;
    player = null;
    return;
  }

  const song = queue[0];
  try {
    // Eğer local test dosyası ise file path ile resource oluştur
    let resource;
    if (song.url === "LOCAL_TEST") {
      const filePath = song.title; // title alanına test dosya yolunu koyacağız
      if (!fs.existsSync(filePath)) {
        textChannel.send("❌ Test dosyası bulunamadı: " + filePath);
        queue.shift();
        return playMusic(guild, textChannel);
      }
      resource = createAudioResource(fs.createReadStream(filePath));
    } else {
      // YouTube/stream kısmı burada daha sonra eklenebilir.
      textChannel.send("❌ Harici stream şu anda devre dışı. Lokal test yapın.");
      queue.shift();
      return playMusic(guild, textChannel);
    }

    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
      attachDebug(connection, player);
      player.on(AudioPlayerStatus.Idle, () => {
        console.log("[AudioPlayer] Idle -> next");
        // temp dosya ise sil
        if (song.url === "LOCAL_TEST" && fs.existsSync(song.title)) {
          try { fs.unlinkSync(song.title); } catch {}
        }
        queue.shift();
        playMusic(guild, textChannel);
      });
      player.on("error", (err) => {
        console.error("[AudioPlayer] error", err);
        textChannel.send("❌ Oynatma hatası: " + err.message);
        queue.shift();
        playMusic(guild, textChannel);
      });
    }

    player.play(resource);
    if (connection) connection.subscribe(player);
    textChannel.send(`🎧 Şu an çalıyor: **${song.title}**`);
  } catch (err) {
    console.error("playMusic catch:", err);
    textChannel.send("❌ Şarkı oynatılamadı.");
    queue.shift();
    playMusic(guild, textChannel);
  }
}

// ===============================
//   DISCORD CLIENT
// ===============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===============================
//   EXPRESS + N8N RELAY
// ===============================
const app = express();
app.use(bodyParser.json());

// N8N → Discord embed
app.post("/n8n", async (req, res) => {
  try { 
    const data = req.body;
    const text = data.text || "Mesaj yok";
    const channelId = data.channel_id || N8N_DEFAULT_CHANNEL;

    if (!channelId) {
      console.log("❌ N8N: Kanal ID bulunamadı.");
      return res.status(400).send("channel_id veya CHANNEL_ID_N8N tanımlı değil");
    }

    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      console.log("❌ N8N: Kanal bulunamadı:", channelId);
      return res.status(404).send("Channel not found");
    }

    const embed = new EmbedBuilder()
      .setTitle("📩 Yeni N8N Mesajı")
      .setDescription(text)
      .setColor("#00BFFF")
      .setTimestamp()
      .setFooter({ text: "Çaylak-Go Relay" });

    await channel.send({ embeds: [embed] });
    res.send("OK");
  } catch (err) {
    console.error("N8N relay hatası:", err);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`Relay API ${PORT} portunda dinlemede...`);
});

// ===============================
//   XP / LEVEL SİSTEMİ
// ===============================
const xpMap = new Map(); // userId -> { xp, level }

function addXP(userId, amount) {
  const data = xpMap.get(userId) || { xp: 0, level: 0 };
  data.xp += amount;
  const needed = (data.level + 1) * 100;
  let leveledUp = false;

  if (data.xp >= needed) {
    data.level++;
    leveledUp = true;
  }

  xpMap.set(userId, data);
  return { ...data, leveledUp };
}

// ===============================
//   MODERASYON AYARLARI
// ===============================
const KUFURLER = [
  "amk",
  "aq",
  "ananı",
  "orospu",
  "siktir",
  "yarrak",
  "piç",
  "göt",
  "sik",
];

const LINK_REGEX = /(https?:\/\/[^\s]+)|(discord\.gg\/[^\s]+)/gi;
const spamMap = new Map(); // userId -> { lastTime, count }

// ===============================
//   LOG SİSTEMİ
// ===============================
let logChannelCache = null;

async function getLogChannel(guild) {
  if (logChannelCache && logChannelCache.guild.id === guild.id) {
    return logChannelCache;
  }

  let ch = guild.channels.cache.find(
    (c) => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText
  );

  if (!ch) {
    ch = await guild.channels.create({
      name: LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      reason: "Log kanalı otomatik oluşturuldu.",
    });
  }

  logChannelCache = ch;
  return ch;
}

async function sendLog(guild, title, description) {
  try {
    const ch = await getLogChannel(guild);
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor("#FFCC00")
      .setTimestamp();
    ch.send({ embeds: [embed] });
  } catch (err) {
    console.error("Log gönderilemedi:", err);
  }
}

// ===============================
//   BOT READY
// ===============================
client.once("clientReady", () => {
  console.log(`🔥 Çaylak-Go MEGABOT aktif: ${client.user.tag}`);
});

// ===============================
//   GİRİŞ / ÇIKIŞ OLAYLARI
// ===============================
client.on("guildMemberAdd", async (member) => {
  // oto rol
  try {
    const role = member.guild.roles.cache.find((r) => r.name === AUTO_ROLE_NAME);
    if (role) {
      await member.roles.add(role, "Oto rol");
      await sendLog(
        member.guild,
        "🧷 Oto Rol",
        `${member} kullanıcısına **${role.name}** rolü verildi.`
      );
    }
  } catch (err) {
    console.error("Oto rol verilemedi:", err);
  }

  // DM
  try {
    await member.send(
      `👋 Selam **${member.user.username}**! Çaylak-Go sunucusuna hoş geldin.\nKuralları oku, takımlara katıl, takıl 🦊`
    );
  } catch {
    /* DM kapalı olabilir */
  }

  // log
  sendLog(
    member.guild,
    "✅ Yeni Üye",
    `${member.user.tag} sunucuya katıldı. (ID: ${member.id})`
  );
});

client.on("guildMemberRemove", async (member) => {
  if (!member.guild) return;
  sendLog(
    member.guild,
    "❌ Çıkış",
    `${member.user.tag} sunucudan ayrıldı. (ID: ${member.id})`
  );
});

// ===============================
//   MESAJ OLAYI: MOD + XP + KOMUTLAR
// ===============================
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content.toLowerCase();

  // --- Küfür filtresi ---
  if (KUFURLER.some((k) => content.includes(k))) {
    await msg.delete().catch(() => {});
    msg.channel
      .send(`⚠️ **${msg.author} küfür etme! Mesajın silindi.**`)
      .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
    sendLog(
      msg.guild,
      "🚫 Küfür Filtresi",
      `${msg.author} küfür kullandı, mesaj silindi.\nKanal: ${msg.channel}`
    );
    return;
  }

  // --- Link filtresi ---
  // if (LINK_REGEX.test(msg.content)) {
  //   await msg.delete().catch(() => {});
  //   msg.channel
  //     .send(`🔗 **${msg.author} izinsiz link yasak!**`)
  //     .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
  //   sendLog(
  //     msg.guild,
  //     "🔗 Link Filtresi",
  //     `${msg.author} link attı, mesaj silindi.\nKanal: ${msg.channel}`
  //   );
  //   return;
  // }

  // --- Basit Anti-Spam ---
  const now = Date.now();
  const spamData =
    spamMap.get(msg.author.id) || { lastTime: 0, count: 0 };

  if (now - spamData.lastTime < 3000) {
    spamData.count++;
    if (spamData.count >= 5) {
      await msg.delete().catch(() => {});
      msg.channel
        .send(`🛑 **${msg.author} spam yapma!**`)
        .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
      sendLog(
        msg.guild,
        "🛑 Anti-Spam",
        `${msg.author} kısa sürede çok mesaj attı (spam).`
      );
      spamData.count = 0;
    }
  } else {
    spamData.count = 1;
  }
  spamData.lastTime = now;
  spamMap.set(msg.author.id, spamData);

  // --- XP Sistemi ---
  const { level, leveledUp } = addXP(msg.author.id, 5);
  if (leveledUp) {
    msg.channel.send(
      `🎉 Tebrikler ${msg.author}, seviye atladın! Yeni seviyen: **${level}**`
    );
    sendLog(
      msg.guild,
      "📈 Level Up",
      `${msg.author} seviye atladı → **${level}**`
    );
  }

  // --- Bot mention cevabı (AI yok, sadece selam) ---
  if (msg.mentions.has(client.user)) {
    return msg.reply("💬 Çağırdın mı aşkım? Buradayım, ama şimdilik AI modum kapalı 🦊");
  }

  // --- Prefix kontrolü ---
  if (!msg.content.startsWith(PREFIX)) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  // ====================
  //   KOMUTLAR
  // ====================

  // !yardım
  if (command === "yardım" || command === "help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Çaylak-Go Komutları")
      .setColor("#00FFAE")
      .setDescription(
        [
          "`!yardım` – Bu yardım menüsü",
          "`!level` – XP ve level durumunu gösterir",
          "`!mute @kullanıcı` – Susturur",
          "`!ticket` – Ticket açar",
          "`!kapat` – Ticket kapatır",
          "`!setup` – Sunucuyu kurar",
          "",
          "**🎵 MÜZİK KOMUTLARI:**",
          "`!çal <url>` – YouTube'dan şarkı çalar",
          "`!kuyruk` – Çalma listesini gösterir",
          "`!geç` – Sonraki şarkıya geçer",
          "`!durdur` – Şarkıyı durdurur",
          "`!devam` – Şarkıyı devam ettirir",
          "`!ayrıl` – Ses kanalından ayrılır",
        ].join("\n")
      );
    return msg.reply({ embeds: [embed] });
  }

  // !level
  if (command === "level") {
    const data = xpMap.get(msg.author.id) || { xp: 0, level: 0 };
    return msg.reply(
      `📊 XP: **${data.xp}** | Seviye: **${data.level}**`
    );
  }

  // !mute
  if (command === "mute") {
    if (
      !msg.member.permissions.has(
        PermissionsBitField.Flags.MuteMembers
      )
    ) {
      return msg.reply("❌ Bu komutu kullanmak için susturma yetkin yok.");
    }

    const member = msg.mentions.members.first();
    if (!member) return msg.reply("❌ Kimi susturacağım? Birini etiketle.");

    let muteRole = msg.guild.roles.cache.find((r) => r.name === "Muted");
    if (!muteRole) {
      muteRole = await msg.guild.roles.create({
        name: "Muted",
        color: "#555555",
        reason: "Mute rolü otomatik oluşturuldu",
      });
    }

    await member.roles.add(muteRole, `Mute komutu: ${msg.author.tag}`);
    msg.channel.send(`🔇 **${member} susturuldu!**`);
    sendLog(
      msg.guild,
      "🔇 Mute",
      `${member} → **${msg.author.tag}** tarafından susturuldu.`
    );
  }

  // !ticket
  if (command === "ticket") {
    return handleTicket(msg);
  }

  // !kapat (ticket içinde)
  if (command === "kapat") {
    if (!msg.channel.name.startsWith("ticket-")) {
      return msg.reply("❌ Bu komut sadece ticket kanallarında kullanılabilir.");
    }

    if (
      !msg.member.permissions.has(
        PermissionsBitField.Flags.ManageChannels
      )
    ) {
      return msg.reply("❌ Bu ticketı kapatma yetkin yok.");
    }

    await msg.channel.send("🔒 Ticket kapatılıyor...");
    sendLog(
      msg.guild,
      "🔒 Ticket Kapandı",
      `${msg.channel.name} kanalı kapatıldı.`
    );
    setTimeout(() => msg.channel.delete().catch(() => {}), 3000);
  }

  // !setup
  if (command === "setup") {
    return runSetup(msg);
  }

  // ===============================
  //   MÜZİK KOMUTLARI
  // ===============================

  // !çal <url>
  if (command === "çal") {
    const url = args[0];
    if (!url) return msg.reply("❌ Bir YouTube linki vermelisin.");

    const voiceChannel = msg.member.voice.channel;
    if (!voiceChannel)
      return msg.reply("🎧 Bir ses kanalına girmen gerekiyor.");

    try {
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: msg.guild.id,
          adapterCreator: msg.guild.voiceAdapterCreator,
        });
      }

      msg.reply(`✅ Ses kanalına bağlanıldı: **${voiceChannel.name}**`);
      queue.push({ url, title: url });

    } catch (err) {
      console.error("Voice connection error:", err);
      msg.reply("❌ Ses kanalına bağlanılamadı.");
    }
  }

  // !ayrıl
  if (command === "ayrıl") {
    if (connection) {
      connection.destroy();
      connection = null;
      msg.reply("👋 Ses kanalından ayrıldım.");
    } else {
      msg.reply("❌ Zaten bir ses kanalında değilim.");
    }
  }
});

// ===============================
//   TICKET SİSTEMİ
// ===============================
async function handleTicket(msg) {
  const guild = msg.guild;
  const member = msg.member;

  let category = guild.channels.cache.find(
    (c) =>
      c.name === TICKET_CATEGORY_NAME &&
      c.type === ChannelType.GuildCategory
  );

  if (!category) {
    category = await guild.channels.create({
      name: TICKET_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Ticket kategorisi otomatik oluşturuldu",
    });
  }

  const chName = `ticket-${member.user.username}`.toLowerCase();
  const existing = guild.channels.cache.find(
    (c) => c.name === chName && c.parentId === category.id
  );

  if (existing) {
    return msg.reply(`🎫 Zaten açık bir ticket kanalın var: ${existing}`);
  }

  const ticketChannel = await guild.channels.create({
    name: chName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: member.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: guild.members.me.id,
        allow: [PermissionsBitField.Flags.ViewChannel],
      },
    ],
  });

  const embed = new EmbedBuilder()
    .setTitle("🎫 Ticket Açıldı")
    .setDescription(
      "Destek ekibi en kısa sürede seninle ilgilenecek.\nTicket'ı kapatmak için `!kapat` yaz."
    )
    .setColor("#FF8800")
    .setTimestamp();

  await ticketChannel.send({ content: `${member}`, embeds: [embed] });

  msg.reply(`🎫 Ticket kanalın oluşturuldu: ${ticketChannel}`);
  sendLog(
    guild,
    "🎫 Ticket Açıldı",
    `${member} için ${ticketChannel} kanalı oluşturuldu.`
  );
}

// ===============================
//   SUNUCU SETUP (!setup)
// ===============================
async function runSetup(msg) {
  if (
    !msg.member.permissions.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return msg.reply("❌ Bu komutu sadece yöneticiler kullanabilir.");
  }

  await msg.reply("⚙️ Çaylak-Go sunucu kurulumu başlatılıyor... ⏳");

  const guild = msg.guild;

  // ROLLER
  const rolesToCreate = [
    { name: "Yönetici", color: "#E74C3C" },
    { name: "Moderatör", color: "#E67E22" },
    { name: AUTO_ROLE_NAME, color: "#00FFC8" },
    { name: "Bot", color: "#5865F2" },
    { name: "Muted", color: "#555555" },
  ];

  for (const r of rolesToCreate) {
    if (!guild.roles.cache.find((role) => role.name === r.name)) {
      await guild.roles.create({
        name: r.name,
        color: r.color,
      });
    }
  }

  // KATEGORİ & KANAL YAPISI
  const structure = {
    "👋 KARŞILAMA": [
      { name: "hoş-geldiniz", type: "text" },
      { name: "kurallar", type: "text" },
      { name: "duyurular", type: "text" },
    ],
    "💬 SOHBET": [
      { name: "genel", type: "text" },
      { name: "medya-akışı", type: "text" },
      { name: "anime-muhabbet", type: "text" },
      { name: "oyun-sohbet", type: "text" },
    ],
    "📚 DESTEK": [
      { name: "destek-oluştur", type: "text" },
    ],
    "🛡️ LOG": [
      { name: LOG_CHANNEL_NAME, type: "text" },
    ],
    "🎧 SES KANALLARI": [
      { name: "Genel Ses", type: "voice" },
      { name: "Müzik Odası", type: "voice" },
      { name: "Sohbet 2", type: "voice" },
      { name: "AFK", type: "voice" },
    ],
    "⚔️ TAKIM ODALARI": [
      { name: "🜁・Aether Squadron", type: "voice" },
      { name: "🜂・Pyro Battalion", type: "voice" },
      { name: "🜃・Gaia Unit", type: "voice" },
      { name: "🜄・Hydro Division", type: "voice" },
    ],
  };

  for (const [categoryName, channels] of Object.entries(structure)) {
    let category = guild.channels.cache.find(
      (c) =>
        c.name === categoryName &&
        c.type === ChannelType.GuildCategory
    );

    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
    }

    for (const chDef of channels) {
      let existing = guild.channels.cache.find(
        (c) => c.name === chDef.name && c.parentId === category.id
      );

      if (!existing) {
        const channelType =
          chDef.type === "voice"
            ? ChannelType.GuildVoice
            : ChannelType.GuildText;

        await guild.channels.create({
          name: chDef.name,
          type: channelType,
          parent: category.id,
        });
      }
    }
  }

  await msg.reply("✅ Çaylak-Go sunucu kurulumu tamamlandı! 🎉");
  sendLog(
    guild,
    "⚙️ Setup",
    `${msg.author.tag} sunucuda otomatik kurulumu çalıştırdı.`
  );
}

// ===============================
//   BOTU BAŞLAT
// ===============================
client.login(TOKEN);

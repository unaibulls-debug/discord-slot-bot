const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MeiliSearch } = require('meilisearch');

// Initialize database
const db = new sqlite3.Database(path.join(__dirname, 'slots.db'));

// Initialize Meilisearch client
let meiliClient = null;
if (process.env.MEILISEARCH_URL && process.env.MEILISEARCH_MASTER_KEY) {
    try {
        meiliClient = new MeiliSearch({
            host: process.env.MEILISEARCH_URL,
            apiKey: process.env.MEILISEARCH_MASTER_KEY,
        });
        console.log('🔍 Meilisearch client initialized');
    } catch (error) {
        console.error('❌ Failed to initialize Meilisearch:', error);
    }
}

// Meilisearch functions for advanced search
async function syncSlotToMeilisearch(slot) {
    if (!meiliClient) return;
    
    try {
        const index = meiliClient.index('slots');
        await index.addDocuments([{
            id: `${slot.user_id}_${slot.guild_id}`,
            user_id: slot.user_id,
            user_tag: slot.user_tag,
            duration: slot.duration,
            category: slot.category,
            creation_date: slot.creation_date,
            expiry_date: slot.expiry_date,
            ping_allowed: slot.ping_allowed,
            guild_id: slot.guild_id,
            channel_id: slot.channel_id,
            role_id: slot.role_id,
            points: slot.points || 0
        }]);
        console.log(`🔍 Synced slot for ${slot.user_tag} to Meilisearch`);
    } catch (error) {
        console.error('❌ Failed to sync slot to Meilisearch:', error);
    }
}

async function removeSlotFromMeilisearch(userId, guildId) {
    if (!meiliClient) return;
    
    try {
        const index = meiliClient.index('slots');
        await index.deleteDocument(`${userId}_${guildId}`);
        console.log(`🗑️ Removed slot from Meilisearch: ${userId}`);
    } catch (error) {
        console.error('❌ Failed to remove slot from Meilisearch:', error);
    }
}

async function searchSlots(query, guildId = null) {
    if (!meiliClient) return { hits: [] };
    
    try {
        const index = meiliClient.index('slots');
        const searchOptions = {
            limit: 20,
            attributesToHighlight: ['user_tag', 'category'],
        };
        
        if (guildId) {
            searchOptions.filter = `guild_id = "${guildId}"`;
        }
        
        const results = await index.search(query, searchOptions);
        return results;
    } catch (error) {
        console.error('❌ Meilisearch search failed:', error);
        return { hits: [] };
    }
}

async function initializeMeilisearchIndex() {
    if (!meiliClient) return;
    
    try {
        const index = meiliClient.index('slots');
        
        // Configure searchable attributes
        await index.updateSearchableAttributes([
            'user_tag',
            'category', 
            'user_id'
        ]);
        
        // Configure filterable attributes
        await index.updateFilterableAttributes([
            'guild_id',
            'category',
            'ping_allowed',
            'points'
        ]);
        
        // Configure sortable attributes
        await index.updateSortableAttributes([
            'creation_date',
            'expiry_date',
            'points'
        ]);
        
        console.log('🔍 Meilisearch index configured successfully');
        
        // Sync existing slots
        db.all('SELECT * FROM slots', (err, rows) => {
            if (!err && rows) {
                rows.forEach(slot => syncSlotToMeilisearch(slot));
                console.log(`🔄 Synced ${rows.length} existing slots to Meilisearch`);
            }
        });
    } catch (error) {
        console.error('❌ Failed to initialize Meilisearch index:', error);
    }
}

// Initialize database tables
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            user_tag TEXT NOT NULL,
            duration INTEGER NOT NULL,
            category TEXT NOT NULL,
            creation_date INTEGER NOT NULL,
            expiry_date INTEGER NOT NULL,
            ping_allowed INTEGER DEFAULT 0,
            guild_id TEXT NOT NULL,
            channel_id TEXT,
            role_id TEXT,
            points INTEGER DEFAULT 0
        )
    `);
    
    // Add new columns if they don't exist
    db.run(`ALTER TABLE slots ADD COLUMN channel_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding channel_id column:', err);
        }
    });
    
    db.run(`ALTER TABLE slots ADD COLUMN role_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding role_id column:', err);
        }
    });
    
    db.run(`ALTER TABLE slots ADD COLUMN points INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding points column:', err);
        } else {
            console.log('✅ Database tables ready with all columns');
        }
    });
    
    db.run(`
        CREATE TABLE IF NOT EXISTS here_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            count INTEGER DEFAULT 0
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS weekly_mention_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            slot_type TEXT NOT NULL,
            week_start TEXT NOT NULL,
            everyone_count INTEGER DEFAULT 0,
            here_count INTEGER DEFAULT 0
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            warning_count INTEGER DEFAULT 0,
            last_warning INTEGER
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS server_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT UNIQUE NOT NULL,
            slot_role_name TEXT DEFAULT 'VIP Slot',
            slot_role_color TEXT DEFAULT '#FFD700',
            logs_channel_id TEXT,
            max_here_per_day INTEGER DEFAULT 1,
            vip_here_per_day INTEGER DEFAULT 2,
            vip_everyone_per_week INTEGER DEFAULT 1,
            auto_role BOOLEAN DEFAULT 1,
            welcome_message TEXT DEFAULT 'Welcome to your VIP slot! 🎉'
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            timestamp INTEGER NOT NULL
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS server_setup (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT UNIQUE NOT NULL,
            welcome_channel_id TEXT,
            rules_channel_id TEXT,
            vouches_channel_id TEXT,
            general_channel_id TEXT,
            member_role_id TEXT,
            staff_role_id TEXT,
            setup_completed BOOLEAN DEFAULT 0
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS welcome_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            joined_at INTEGER NOT NULL
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS invitation_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            points INTEGER DEFAULT 0,
            total_invites INTEGER DEFAULT 0,
            last_updated INTEGER NOT NULL
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS invite_tracking (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            invite_code TEXT NOT NULL,
            inviter_id TEXT NOT NULL,
            uses INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites
    ]
});

// Helper functions
function formatDuration(days) {
    if (days === 1) return '1 day';
    return `${days} days`;
}

function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

function getWeekStartString() {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day;
    const monday = new Date(today.setDate(diff));
    return monday.toISOString().split('T')[0];
}

function getWeeklyMentionUsage(userId, guildId, slotType, callback) {
    const weekStart = getWeekStartString();
    db.get(
        'SELECT * FROM weekly_mention_usage WHERE user_id = ? AND guild_id = ? AND slot_type = ? AND week_start = ?',
        [userId, guildId, slotType, weekStart],
        callback
    );
}

function incrementWeeklyMentions(userId, guildId, slotType, mentionType, callback) {
    const weekStart = getWeekStartString();
    
    getWeeklyMentionUsage(userId, guildId, slotType, (err, row) => {
        if (err) return callback(err);
        
        const field = mentionType === 'everyone' ? 'everyone_count' : 'here_count';
        
        if (row) {
            db.run(
                `UPDATE weekly_mention_usage SET ${field} = ${field} + 1 WHERE user_id = ? AND guild_id = ? AND slot_type = ? AND week_start = ?`,
                [userId, guildId, slotType, weekStart],
                callback
            );
        } else {
            const initialCount = mentionType === 'everyone' ? { everyone_count: 1, here_count: 0 } : { everyone_count: 0, here_count: 1 };
            db.run(
                'INSERT INTO weekly_mention_usage (user_id, guild_id, slot_type, week_start, everyone_count, here_count) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, guildId, slotType, weekStart, initialCount.everyone_count, initialCount.here_count],
                callback
            );
        }
    });
}

function getServerConfig(guildId, callback) {
    db.get(
        'SELECT * FROM server_config WHERE guild_id = ?',
        [guildId],
        (err, row) => {
            if (err) return callback(err);
            if (!row) {
                // Create default config
                db.run(
                    'INSERT INTO server_config (guild_id) VALUES (?)',
                    [guildId],
                    function(err) {
                        if (err) return callback(err);
                        getServerConfig(guildId, callback);
                    }
                );
            } else {
                callback(null, row);
            }
        }
    );
}

function updateServerConfig(guildId, field, value, callback) {
    const sql = `UPDATE server_config SET ${field} = ? WHERE guild_id = ?`;
    db.run(sql, [value, guildId], callback);
}

function logActivity(guildId, userId, action, details, callback) {
    db.run(
        'INSERT INTO activity_logs (guild_id, user_id, action, details, timestamp) VALUES (?, ?, ?, ?, ?)',
        [guildId, userId, action, details, Date.now()],
        callback || (() => {})
    );
}

function addPoints(userId, guildId, points, callback) {
    db.run(
        'UPDATE slots SET points = points + ? WHERE user_id = ? AND guild_id = ?',
        [points, userId, guildId],
        callback
    );
}

async function createSlotRole(guild, config) {
    try {
        const role = await guild.roles.create({
            name: config.slot_role_name || 'VIP Slot',
            color: config.slot_role_color || '#FFD700',
            reason: 'Auto-created slot role',
            permissions: [
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.UseExternalEmojis,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory
            ],
            mentionable: false
        });
        return role;
    } catch (error) {
        console.error('Error creating role:', error);
        throw new Error(`No se pudo crear el rol: ${error.message}`);
    }
}

function createAdvancedEmbed(title, color = 0x00AE86) {
    return new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: 'Discord Slot Bot • Enhanced Version' });
}

// Server setup functions
function getServerSetup(guildId, callback) {
    db.get(
        'SELECT * FROM server_setup WHERE guild_id = ?',
        [guildId],
        (err, row) => {
            if (err) return callback(err);
            if (!row) {
                // Create default setup
                db.run(
                    'INSERT INTO server_setup (guild_id) VALUES (?)',
                    [guildId],
                    function(err) {
                        if (err) return callback(err);
                        getServerSetup(guildId, callback);
                    }
                );
            } else {
                callback(null, row);
            }
        }
    );
}

function updateServerSetup(guildId, field, value, callback) {
    const sql = `UPDATE server_setup SET ${field} = ? WHERE guild_id = ?`;
    db.run(sql, [value, guildId], callback);
}

function saveWelcomeMessage(guildId, userId, username, callback) {
    db.run(
        'INSERT INTO welcome_messages (guild_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)',
        [guildId, userId, username, Date.now()],
        callback || (() => {})
    );
}

// Invitation points system functions
function getInvitePoints(userId, guildId, callback) {
    db.get(
        'SELECT * FROM invitation_points WHERE user_id = ? AND guild_id = ?',
        [userId, guildId],
        (err, row) => {
            if (err) return callback(err);
            if (!row) {
                // Create default entry
                db.run(
                    'INSERT INTO invitation_points (user_id, guild_id, points, total_invites, last_updated) VALUES (?, ?, 0, 0, ?)',
                    [userId, guildId, Date.now()],
                    function(err) {
                        if (err) return callback(err);
                        callback(null, { user_id: userId, guild_id: guildId, points: 0, total_invites: 0, last_updated: Date.now() });
                    }
                );
            } else {
                callback(null, row);
            }
        }
    );
}

function addInvitePoints(userId, guildId, points, callback) {
    getInvitePoints(userId, guildId, (err, currentData) => {
        if (err) return callback(err);
        
        db.run(
            'UPDATE invitation_points SET points = points + ?, total_invites = total_invites + ?, last_updated = ? WHERE user_id = ? AND guild_id = ?',
            [points, 1, Date.now(), userId, guildId],
            callback
        );
    });
}

function subtractInvitePoints(userId, guildId, points, callback) {
    db.run(
        'UPDATE invitation_points SET points = points - ?, last_updated = ? WHERE user_id = ? AND guild_id = ? AND points >= ?',
        [points, Date.now(), userId, guildId, points],
        function(err) {
            if (err) return callback(err);
            callback(null, this.changes > 0);
        }
    );
}

function getTopInviters(guildId, limit, callback) {
    db.all(
        'SELECT * FROM invitation_points WHERE guild_id = ? ORDER BY total_invites DESC LIMIT ?',
        [guildId, limit || 10],
        callback
    );
}

async function setupDiscordServer(guild) {
    try {
        console.log(`🚀 Setting up Discord server: ${guild.name}`);
        
        // Create main categories
        const infoCategory = await guild.channels.create({
            name: '📋 INFORMATION',
            type: ChannelType.GuildCategory,
            reason: 'Server setup - Information category'
        });
        
        const generalCategory = await guild.channels.create({
            name: '💬 GENERAL',
            type: ChannelType.GuildCategory,
            reason: 'Server setup - General category'
        });
        
        const slotsCategory = await guild.channels.create({
            name: '⭐ VIP SLOTS',
            type: ChannelType.GuildCategory,
            reason: 'Server setup - Slots category'
        });
        
        const freeSlotsCategory = await guild.channels.create({
            name: '🎫 FREE SLOTS',
            type: ChannelType.GuildCategory,
            reason: 'Server setup - Free Slots category'
        });
        
        const vouchesCategory = await guild.channels.create({
            name: '✅ VOUCHES',
            type: ChannelType.GuildCategory,
            reason: 'Server setup - Vouches category'
        });
        
        // Create roles
        const memberRole = await guild.roles.create({
            name: '👤 Member',
            color: '#95A5A6',
            reason: 'Server setup - Member role'
        });
        
        const staffRole = await guild.roles.create({
            name: '🛡️ Staff',
            color: '#E74C3C',
            permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers],
            reason: 'Server setup - Staff role'
        });
        
        const vipRole = await guild.roles.create({
            name: '⭐ VIP Slot',
            color: '#F1C40F',
            reason: 'Server setup - VIP role'
        });
        
        // Information channels
        const rulesChannel = await guild.channels.create({
            name: '📜┃rules',
            type: ChannelType.GuildText,
            parent: infoCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionFlagsBits.SendMessages],
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                }
            ],
            reason: 'Server setup - Rules channel'
        });
        
        const welcomeChannel = await guild.channels.create({
            name: '👋┃welcome',
            type: ChannelType.GuildText,
            parent: infoCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionFlagsBits.SendMessages],
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                }
            ],
            reason: 'Server setup - Welcome channel'
        });
        
        const announcementsChannel = await guild.channels.create({
            name: '📢┃announcements',
            type: ChannelType.GuildText,
            parent: infoCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionFlagsBits.SendMessages],
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                },
                {
                    id: staffRole.id,
                    allow: [PermissionFlagsBits.SendMessages]
                }
            ],
            reason: 'Server setup - Announcements channel'
        });
        
        // General channels
        const generalChannel = await guild.channels.create({
            name: '💬┃general',
            type: ChannelType.GuildText,
            parent: generalCategory.id,
            reason: 'Server setup - General chat'
        });
        
        const commandsChannel = await guild.channels.create({
            name: '🤖┃commands',
            type: ChannelType.GuildText,
            parent: generalCategory.id,
            reason: 'Server setup - Bot commands'
        });
        
        // Vouches channels
        const vouchesChannel = await guild.channels.create({
            name: '✅┃vouches',
            type: ChannelType.GuildText,
            parent: vouchesCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: vipRole.id,
                    allow: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: staffRole.id,
                    allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                }
            ],
            reason: 'Server setup - Vouches channel'
        });
        
        // Staff channels
        const staffCategory = await guild.channels.create({
            name: '🛡️ STAFF',
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: staffRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                }
            ],
            reason: 'Server setup - Staff category'
        });
        
        const staffChat = await guild.channels.create({
            name: '💼┃staff-chat',
            type: ChannelType.GuildText,
            parent: staffCategory.id,
            reason: 'Server setup - Staff chat'
        });
        
        const logsChannel = await guild.channels.create({
            name: '📊┃logs',
            type: ChannelType.GuildText,
            parent: staffCategory.id,
            reason: 'Server setup - Logs channel'
        });
        
        // Save setup to database
        updateServerSetup(guild.id, 'welcome_channel_id', welcomeChannel.id, () => {});
        updateServerSetup(guild.id, 'rules_channel_id', rulesChannel.id, () => {});
        updateServerSetup(guild.id, 'vouches_channel_id', vouchesChannel.id, () => {});
        updateServerSetup(guild.id, 'general_channel_id', generalChannel.id, () => {});
        updateServerSetup(guild.id, 'member_role_id', memberRole.id, () => {});
        updateServerSetup(guild.id, 'staff_role_id', staffRole.id, () => {});
        updateServerSetup(guild.id, 'setup_completed', 1, () => {});
        
        // Update server config with new roles and channels
        updateServerConfig(guild.id, 'slot_role_name', vipRole.name, () => {});
        updateServerConfig(guild.id, 'slot_role_color', vipRole.hexColor, () => {});
        updateServerConfig(guild.id, 'logs_channel_id', logsChannel.id, () => {});
        
        return {
            welcomeChannel,
            rulesChannel,
            vouchesChannel,
            generalChannel,
            memberRole,
            staffRole,
            vipRole,
            logsChannel
        };
        
    } catch (error) {
        console.error('Error setting up Discord server:', error);
        throw error;
    }
}

async function sendWelcomeMessages(channels) {
    try {
        // Rules channel embed
        const rulesEmbed = createAdvancedEmbed('📜 Server Rules', 0xE74C3C)
            .setDescription('**Welcome to our server!** 🎉\n\nPlease read and respect the following rules:')
            .addFields([
                { name: '1️⃣ Respect', value: 'Treat all members with respect and courtesy.', inline: false },
                { name: '2️⃣ No Spam', value: 'Do not spam, flood or mass mention.', inline: false },
                { name: '3️⃣ Appropriate Content', value: 'Do not share NSFW, offensive or illegal content.', inline: false },
                { name: '4️⃣ Channel Purpose', value: 'Use each channel for its specific purpose.', inline: false },
                { name: '5️⃣ No Self-Promotion', value: 'Do not advertise without staff authorization.', inline: false },
                { name: '6️⃣ VIP Slots', value: 'VIP slots have @here limits. Follow the rules.', inline: false }
            ])
            .setFooter({ text: 'Breaking these rules may result in penalties.' });
        
        await channels.rulesChannel.send({ embeds: [rulesEmbed] });
        
        // Welcome channel embed with custom design
        const welcomeEmbed = createAdvancedEmbed('🎉 Welcome to the Server!', 0x00FF00)
            .setDescription('Hello and welcome to our amazing server! 🚀\n\n**What can you do here?**\n\n💬 **Socialize**\nChat in <#' + channels.generalChannel.id + '> and meet new people.\n\n⭐ **VIP Slots**\nGet VIP access and enjoy exclusive benefits.\n\n✅ **Vouches**\nShare and read testimonials in <#' + channels.vouchesChannel.id + '>.\n\n🤖 **Commands**\nUse bot commands in <#' + channels.generalChannel.id + '>.\n\n📋 **Important**\n• Read the rules in <#' + channels.rulesChannel.id + '>\n• Respect all members\n• Have fun!')
            .setFooter({ text: 'Discord Slot Bot • Enhanced Version • yesterday at 4:18 PM' });
        
        await channels.welcomeChannel.send({ embeds: [welcomeEmbed] });
        
        // Vouches channel embed
        const vouchesEmbed = createAdvancedEmbed('✅ Vouches Channel', 0xF1C40F)
            .setDescription('**Welcome to the vouches channel!** 🌟\n\nHere you can share and read testimonials from other users.')
            .addFields([
                { name: '📝 How to vouch?', value: 'Only VIP users can write vouches here.', inline: false },
                { name: '⭐ Recommended format', value: '**User:** @username\n**Service:** Description\n**Rating:** ⭐⭐⭐⭐⭐\n**Comment:** Your experience', inline: false },
                { name: '🚫 Rules', value: '• Only real vouches\n• No spam\n• Be honest and constructive', inline: false }
            ]);
        
        await channels.vouchesChannel.send({ embeds: [vouchesEmbed] });
        
        console.log('✅ Welcome messages sent to all channels');
        
    } catch (error) {
        console.error('Error sending welcome messages:', error);
    }
}

function addSlot(userId, userTag, duration, category, guildId, channelId, roleId, callback) {
    const now = Date.now();
    const expiry = now + (duration * 24 * 60 * 60 * 1000);
    
    db.run(
        'INSERT INTO slots (user_id, user_tag, duration, category, creation_date, expiry_date, ping_allowed, guild_id, channel_id, role_id, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, userTag, duration, category, now, expiry, 0, guildId, channelId, roleId, 0],
        function(err) {
            if (!err && this.lastID) {
                // Sync to Meilisearch
                const slot = {
                    user_id: userId,
                    user_tag: userTag,
                    duration: duration,
                    category: category,
                    creation_date: now,
                    expiry_date: expiry,
                    ping_allowed: 0,
                    guild_id: guildId,
                    channel_id: channelId,
                    role_id: roleId,
                    points: 0
                };
                syncSlotToMeilisearch(slot);
            }
            if (callback) callback(err);
        }
    );
}

function getSlot(userId, guildId, callback) {
    db.get(
        'SELECT * FROM slots WHERE user_id = ? AND guild_id = ? AND expiry_date > ?',
        [userId, guildId, Date.now()],
        callback
    );
}

function removeSlot(userId, guildId, callback) {
    db.run(
        'DELETE FROM slots WHERE user_id = ? AND guild_id = ?',
        [userId, guildId],
        function(err) {
            if (!err) {
                // Remove from Meilisearch
                removeSlotFromMeilisearch(userId, guildId);
            }
            if (callback) callback(err);
        }
    );
}

function getAllSlots(guildId, callback) {
    db.all(
        'SELECT * FROM slots WHERE guild_id = ? AND expiry_date > ?',
        [guildId, Date.now()],
        callback
    );
}

function getHereUsage(userId, guildId, callback) {
    const today = getTodayString();
    db.get(
        'SELECT * FROM here_usage WHERE user_id = ? AND guild_id = ? AND usage_date = ?',
        [userId, guildId, today],
        callback
    );
}

function incrementHereUsage(userId, guildId, callback) {
    const today = getTodayString();
    
    getHereUsage(userId, guildId, (err, row) => {
        if (err) return callback(err);
        
        if (row) {
            db.run(
                'UPDATE here_usage SET count = count + 1 WHERE user_id = ? AND guild_id = ? AND usage_date = ?',
                [userId, guildId, today],
                callback
            );
        } else {
            db.run(
                'INSERT INTO here_usage (user_id, guild_id, usage_date, count) VALUES (?, ?, ?, 1)',
                [userId, guildId, today],
                callback
            );
        }
    });
}

function getWarnings(userId, guildId, callback) {
    db.get(
        'SELECT * FROM warnings WHERE user_id = ? AND guild_id = ?',
        [userId, guildId],
        callback
    );
}

function addWarning(userId, guildId, callback) {
    const now = Date.now();
    
    getWarnings(userId, guildId, (err, row) => {
        if (err) return callback(err);
        
        if (row) {
            db.run(
                'UPDATE warnings SET warning_count = warning_count + 1, last_warning = ? WHERE user_id = ? AND guild_id = ?',
                [now, userId, guildId],
                callback
            );
        } else {
            db.run(
                'INSERT INTO warnings (user_id, guild_id, warning_count, last_warning) VALUES (?, ?, 1, ?)',
                [userId, guildId, now],
                callback
            );
        }
    });
}

// Bot events
client.once('ready', async () => {
    console.log(`🚀 ${client.user.tag} is online!`);
    
    // Load invites for all guilds to track usage
    try {
        for (const guild of client.guilds.cache.values()) {
            try {
                const invites = await guild.invites.fetch();
                const inviteMap = new Map();
                invites.forEach(invite => inviteMap.set(invite.code, invite));
                guildInvites.set(guild.id, inviteMap);
                console.log(`📋 Loaded ${invites.size} invites for ${guild.name}`);
            } catch (error) {
                console.error(`Error loading invites for ${guild.name}:`, error);
            }
        }
        console.log('✅ Member join detection enabled!');
    } catch (error) {
        console.error('Error loading guild invites:', error);
    }
    
    // Initialize Meilisearch
    if (meiliClient) {
        try {
            await initializeMeilisearchIndex();
        } catch (error) {
            console.error('❌ Failed to initialize Meilisearch:', error);
        }
    }
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('freeslot')
            .setDescription('Create a free slot with automatic role and channel')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to give the slot to')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('duration')
                    .setDescription('Duration in days')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(365))
            .addStringOption(option => 
                option.setName('category')
                    .setDescription('Category for the slot')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('channel_name')
                    .setDescription('Custom name for the channel (without spaces or special characters)')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('vipslot')
            .setDescription('💎 Create a VIP slot with premium benefits')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to give the VIP slot to')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('duration')
                    .setDescription('Duration in days')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(365))
            .addStringOption(option => 
                option.setName('category')
                    .setDescription('Category for the VIP slot')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('channel_name')
                    .setDescription('Custom name for the channel (without spaces or special characters)')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('slotinfo')
            .setDescription('Check detailed slot information and statistics')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to check (defaults to yourself)')
                    .setRequired(false)),
        
        new SlashCommandBuilder()
            .setName('removeslot')
            .setDescription('Remove a user\'s slot, channel, and role')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to remove slot from')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('addhere')
            .setDescription('Add @here usage to a user (admin command)')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to add @here usage to')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('addevryone')
            .setDescription('Add @everyone usage to a VIP user (admin command)')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('VIP user to add @everyone usage to')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('warn')
            .setDescription('Warn a user for excessive @here usage')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to warn')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('hereused')
            .setDescription('Quick report that a user used @here (for monitoring)')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User who used @here')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        
        new SlashCommandBuilder()
            .setName('slotconfig')
            .setDescription('Configure slot system settings')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('role')
                    .setDescription('Configure slot role settings')
                    .addStringOption(option => 
                        option.setName('name')
                            .setDescription('Role name for slot users')
                            .setRequired(true))
                    .addStringOption(option => 
                        option.setName('color')
                            .setDescription('Role color (hex code like #FFD700)')
                            .setRequired(false)))
            .addSubcommand(subcommand =>
                subcommand
                    .setName('limits')
                    .setDescription('Configure usage limits')
                    .addIntegerOption(option => 
                        option.setName('here_limit')
                            .setDescription('Max @here uses per day')
                            .setRequired(true)
                            .setMinValue(1)
                            .setMaxValue(10)))
            .addSubcommand(subcommand =>
                subcommand
                    .setName('logs')
                    .setDescription('Set logs channel')
                    .addChannelOption(option => 
                        option.setName('channel')
                            .setDescription('Channel for activity logs')
                            .setRequired(true)))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('slotstats')
            .setDescription('View server slot statistics and leaderboard')
            .addStringOption(option => 
                option.setName('type')
                    .setDescription('Type of statistics to view')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Overview', value: 'overview' },
                        { name: 'Active Slots', value: 'active' },
                        { name: 'Recent Activity', value: 'activity' },
                        { name: 'Points Leaderboard', value: 'points' }
                    )),
        
        new SlashCommandBuilder()
            .setName('givepoints')
            .setDescription('Give points to a slot user')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to give points to')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('points')
                    .setDescription('Number of points to give')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(1000))
            .addStringOption(option => 
                option.setName('reason')
                    .setDescription('Reason for giving points')
                    .setRequired(false))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('slothelp')
            .setDescription('Show help and commands for the slot system'),
        
        new SlashCommandBuilder()
            .setName('searchslots')
            .setDescription('Search slots using advanced filters (powered by Meilisearch)')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('Search query (username, category, etc.)')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('category')
                    .setDescription('Filter by category')
                    .setRequired(false)),
        
        // Server Setup Commands
        new SlashCommandBuilder()
            .setName('setupserver')
            .setDescription('Configure the Discord server automatically with organized channels and roles')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
        new SlashCommandBuilder()
            .setName('vouch')
            .setDescription('Create a vouch for someone')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('User to vouch for')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('service')
                    .setDescription('Service or interaction description')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('rating')
                    .setDescription('Rating from 1 to 5 stars')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(5))
            .addStringOption(option => 
                option.setName('comment')
                    .setDescription('Additional comments about the experience')
                    .setRequired(false)),
        
        new SlashCommandBuilder()
            .setName('serverinfo')
            .setDescription('View server setup information and statistics'),
        
        new SlashCommandBuilder()
            .setName('fillchannels')
            .setDescription('Fill all channels with selling slot content and anti-scam policies')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
            
        new SlashCommandBuilder()
            .setName('invitepoints')
            .setDescription('Check your invitation points')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('User to check points for (admin only)')
                    .setRequired(false)),
                    
        new SlashCommandBuilder()
            .setName('redeemslot')
            .setDescription('Redeem invitation points for a free slot')
            .addIntegerOption(option =>
                option.setName('days')
                    .setDescription('Number of days for the free slot')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(30))
            .addStringOption(option =>
                option.setName('category')
                    .setDescription('Category for your slot')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('channel_name')
                    .setDescription('Name for your channel (without spaces)')
                    .setRequired(true)),
                    
        new SlashCommandBuilder()
            .setName('inviteleaderboard')
            .setDescription('View the top inviters leaderboard'),
            
        new SlashCommandBuilder()
            .setName('inviteinfo')
            .setDescription('Learn about the invitation rewards system')
    ];
    
    try {
        await client.application.commands.set(commands);
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName, options, guild, user } = interaction;
    
    if (commandName === 'freeslot') {
        const targetUser = options.getUser('user');
        const duration = options.getInteger('duration');
        const category = options.getString('category');
        const channelName = options.getString('channel_name');
        
        await interaction.deferReply();
        
        // Check if user already has a slot
        getSlot(targetUser.id, guild.id, async (err, existingSlot) => {
            if (err) {
                return interaction.editReply({ content: '❌ Database error occurred.' });
            }
            
            if (existingSlot) {
                return interaction.editReply({ 
                    content: `❌ ${targetUser.tag} already has an active slot.`
                });
            }
            
            try {
                // Get server configuration
                getServerConfig(guild.id, async (err, config) => {
                    if (err) {
                        return interaction.editReply({ content: '❌ Failed to get server configuration.' });
                    }
                    
                    let slotRole = null;
                    
                    // Create or find slot role if auto_role is enabled
                    if (config.auto_role) {
                        try {
                            slotRole = guild.roles.cache.find(role => role.name === config.slot_role_name);
                            if (!slotRole) {
                                slotRole = await createSlotRole(guild, config);
                            }
                            
                            if (slotRole) {
                                try {
                                    const targetMember = await guild.members.fetch(targetUser.id);
                                    await targetMember.roles.add(slotRole, `VIP Slot granted by ${user.tag}`);
                                } catch (error) {
                                    console.error('Error adding role:', error);
                                    return interaction.editReply({ 
                                        content: `❌ No se pudo asignar el rol al usuario. Verifica que el bot tenga permisos para gestionar roles y que el rol del bot esté por encima del rol VIP en la jerarquía.` 
                                    });
                                }
                            }
                        } catch (error) {
                            console.error('Error creating role:', error);
                            return interaction.editReply({ 
                                content: `❌ No se pudo crear el rol VIP. Error: ${error.message}. Verifica que el bot tenga permisos para gestionar roles.` 
                            });
                        }
                    }
                    
                    // Find or create "FREE | slots" category for free slots
                    let slotsCategory = guild.channels.cache.find(channel => 
                        (channel.name.toLowerCase().includes('free') && channel.name.toLowerCase().includes('slots')) && channel.type === ChannelType.GuildCategory
                    );
                    
                    if (!slotsCategory) {
                        try {
                            slotsCategory = await guild.channels.create({
                                name: '🌟 FREE | slots',
                                type: ChannelType.GuildCategory,
                                reason: 'Creating free slots category for slot management'
                            });
                        } catch (error) {
                            console.error('Error creating free slots category:', error);
                            return interaction.editReply({ 
                                content: `❌ No se pudo crear la categoría de free slots. Verifica que el bot tenga permisos para gestionar canales.` 
                            });
                        }
                    }
                    
                    // Validate and prepare channel name with ⭐| prefix for free slots
                    const cleanChannelName = `⭐-${channelName.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')}`;
                    if (cleanChannelName === '⭐-') {
                        return interaction.editReply({ 
                            content: `❌ El nombre del canal "${channelName}" no es válido. Use solo letras, números y guiones.` 
                        });
                    }
                    
                    // Check if channel name already exists
                    const existingChannel = guild.channels.cache.find(channel => 
                        channel.name === cleanChannelName && channel.parent === slotsCategory?.id
                    );
                    if (existingChannel) {
                        return interaction.editReply({ 
                            content: `❌ Ya existe un canal con el nombre "${cleanChannelName}". Elige un nombre diferente.` 
                        });
                    }

                    // Create user channel with enhanced permissions
                    const permissionOverwrites = [
                        {
                            id: guild.roles.everyone,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                            deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.UseExternalEmojis]
                        },
                        {
                            id: targetUser.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.UseExternalEmojis,
                                PermissionFlagsBits.AddReactions
                            ]
                        }
                    ];
                    
                    // Add role permissions if role exists
                    if (slotRole) {
                        permissionOverwrites.push({
                            id: slotRole.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.UseExternalEmojis,
                                PermissionFlagsBits.AddReactions
                            ]
                        });
                    }
                    
                    let userChannel;
                    try {
                        userChannel = await guild.channels.create({
                            name: cleanChannelName,
                            type: ChannelType.GuildText,
                            parent: slotsCategory.id,
                            reason: `Creating free slot channel for ${targetUser.tag}`,
                            permissionOverwrites
                        });
                    } catch (error) {
                        console.error('Error creating user channel:', error);
                        return interaction.editReply({ 
                            content: `❌ No se pudo crear el canal del usuario. Verifica que el bot tenga permisos para gestionar canales y roles. Error: ${error.message}` 
                        });
                    }
                    
                    // Add slot to database with channel and role ID
                    addSlot(targetUser.id, targetUser.tag, duration, category, guild.id, userChannel.id, slotRole?.id, async (err) => {
                        if (err) {
                            console.error('Database error when creating slot:', err);
                            // Clean up channel and role if database fails
                            userChannel.delete().catch(console.error);
                            if (slotRole) {
                                const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
                                if (targetMember && targetMember.roles.cache.has(slotRole.id)) {
                                    targetMember.roles.remove(slotRole).catch(console.error);
                                }
                            }
                            return interaction.editReply({ content: `❌ Failed to create free slot. Error: ${err.message}` });
                        }
                        
                        // Log activity
                        logActivity(guild.id, targetUser.id, 'FREE_SLOT_CREATED', `Duration: ${duration} days, Category: ${category}`);
                        
                        const embed = createAdvancedEmbed('🆓 Free Slot Created Successfully!', 0x00FF00)
                            .setDescription(`**${targetUser.tag}** has been granted a premium slot!`)
                            .addFields([
                                { name: '👤 User', value: `${targetUser}`, inline: true },
                                { name: '⏰ Duration', value: formatDuration(duration), inline: true },
                                { name: '🏷️ Category', value: category, inline: true },
                                { name: '📅 Created', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                                { name: '🗓️ Expires', value: `<t:${Math.floor((Date.now() + duration * 24 * 60 * 60 * 1000) / 1000)}:F>`, inline: true },
                                { name: '🔔 Free Limits', value: `@here: ${config.max_here_per_day}/day`, inline: true },
                                { name: '💬 Channel', value: `${userChannel}`, inline: true },
                                { name: '🏆 Role', value: slotRole ? `${slotRole}` : 'None', inline: true },
                                { name: '✨ Points', value: '0', inline: true }
                            ])
                            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                            .setImage('attachment://free_slots_image.png');
                        
                        const freeSlotImage = new AttachmentBuilder('./free_slots_image.png', { name: 'free_slots_image.png' });
                        interaction.editReply({ embeds: [embed], files: [freeSlotImage] });
                        
                        // Send enhanced welcome message to the new channel
                        const welcomeEmbed = createAdvancedEmbed(`Welcome to Your VIP Slot! 🎉`, 0xFFD700)
                            .setDescription(`Hello ${targetUser}! 👋\n\n**Your Free Slot Benefits:**\n• Personal channel for ${formatDuration(duration)}\n• ${config.max_here_per_day} @here ping per day\n• Point earning system\n\n**Commands you can use:**\n• \`/slotinfo\` - Check your slot details\n• \`/slotstats points\` - View points leaderboard\n\nEnjoy your slot experience! ✨`)
                            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));
                        
                        userChannel.send({ embeds: [welcomeEmbed] });
                        
                        // Send to logs channel if configured
                        if (config.logs_channel_id) {
                            const logsChannel = guild.channels.cache.get(config.logs_channel_id);
                            if (logsChannel) {
                                const logEmbed = createAdvancedEmbed('📈 Slot Activity Log', 0x0099FF)
                                    .addFields([
                                        { name: 'Action', value: 'Slot Created', inline: true },
                                        { name: 'User', value: `${targetUser.tag}`, inline: true },
                                        { name: 'Admin', value: `${user.tag}`, inline: true },
                                        { name: 'Duration', value: formatDuration(duration), inline: true },
                                        { name: 'Category', value: category, inline: true },
                                        { name: 'Channel', value: `${userChannel}`, inline: true }
                                    ]);
                                logsChannel.send({ embeds: [logEmbed] });
                            }
                        }
                    });
                });
                
            } catch (error) {
                console.error('Error creating slot:', error);
                return interaction.editReply({ content: '❌ Failed to create slot. Make sure the bot has proper permissions.' });
            }
        });
    }
    
    else if (commandName === 'vipslot') {
        const targetUser = options.getUser('user');
        const duration = options.getInteger('duration');
        const category = options.getString('category');
        const channelName = options.getString('channel_name');
        
        await interaction.deferReply();
        
        // Check if user already has a slot
        getSlot(targetUser.id, guild.id, async (err, existingSlot) => {
            if (err) {
                return interaction.editReply({ content: '❌ Database error occurred.' });
            }
            
            if (existingSlot) {
                return interaction.editReply({ 
                    content: `❌ ${targetUser.tag} already has an active slot.`
                });
            }
            
            try {
                // Get server configuration
                getServerConfig(guild.id, async (err, config) => {
                    if (err) {
                        return interaction.editReply({ content: '❌ Failed to get server configuration.' });
                    }
                    
                    let slotRole = null;
                    
                    // Create or find slot role if auto_role is enabled
                    if (config.auto_role) {
                        try {
                            slotRole = guild.roles.cache.find(role => role.name === config.slot_role_name);
                            if (!slotRole) {
                                slotRole = await createSlotRole(guild, config);
                            }
                            
                            if (slotRole) {
                                try {
                                    const targetMember = await guild.members.fetch(targetUser.id);
                                    await targetMember.roles.add(slotRole, `VIP Slot granted by ${user.tag}`);
                                } catch (error) {
                                    console.error('Error adding role:', error);
                                    return interaction.editReply({ 
                                        content: `❌ No se pudo asignar el rol al usuario. Verifica que el bot tenga permisos para gestionar roles y que el rol del bot esté por encima del rol VIP en la jerarquía.` 
                                    });
                                }
                            }
                        } catch (error) {
                            console.error('Error creating role:', error);
                            return interaction.editReply({ 
                                content: `❌ No se pudo crear el rol VIP. Error: ${error.message}. Verifica que el bot tenga permisos para gestionar roles.` 
                            });
                        }
                    }
                    
                    // Find or create "VIP | slots" category for VIP slots
                    let slotsCategory = guild.channels.cache.find(channel => 
                        (channel.name.toLowerCase().includes('vip') && channel.name.toLowerCase().includes('slots')) && channel.type === ChannelType.GuildCategory
                    );
                    
                    if (!slotsCategory) {
                        try {
                            slotsCategory = await guild.channels.create({
                                name: '💎 VIP | slots',
                                type: ChannelType.GuildCategory,
                                reason: 'Creating VIP slots category for slot management'
                            });
                        } catch (error) {
                            console.error('Error creating VIP slots category:', error);
                            return interaction.editReply({ 
                                content: `❌ No se pudo crear la categoría de VIP slots. Verifica que el bot tenga permisos para gestionar canales.` 
                            });
                        }
                    }
                    
                    // Validate and prepare channel name with 💎| prefix for VIP slots
                    const cleanChannelName = `💎-${channelName.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')}`;
                    if (cleanChannelName === '💎-') {
                        return interaction.editReply({ 
                            content: `❌ El nombre del canal "${channelName}" no es válido. Use solo letras, números y guiones.` 
                        });
                    }
                    
                    // Check if channel name already exists
                    const existingChannel = guild.channels.cache.find(channel => 
                        channel.name === cleanChannelName && channel.parent === slotsCategory?.id
                    );
                    if (existingChannel) {
                        return interaction.editReply({ 
                            content: `❌ Ya existe un canal con el nombre "${cleanChannelName}". Elige un nombre diferente.` 
                        });
                    }

                    // Create user channel with enhanced permissions
                    const permissionOverwrites = [
                        {
                            id: guild.roles.everyone,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                            deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.UseExternalEmojis]
                        },
                        {
                            id: targetUser.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.UseExternalEmojis,
                                PermissionFlagsBits.AddReactions
                            ]
                        }
                    ];
                    
                    // Add role permissions if role exists
                    if (slotRole) {
                        permissionOverwrites.push({
                            id: slotRole.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.UseExternalEmojis,
                                PermissionFlagsBits.AddReactions
                            ]
                        });
                    }
                    
                    let userChannel;
                    try {
                        userChannel = await guild.channels.create({
                            name: cleanChannelName,
                            type: ChannelType.GuildText,
                            parent: slotsCategory.id,
                            reason: `Creating VIP slot channel for ${targetUser.tag}`,
                            permissionOverwrites
                        });
                    } catch (error) {
                        console.error('Error creating user channel:', error);
                        return interaction.editReply({ 
                            content: `❌ No se pudo crear el canal del usuario. Verifica que el bot tenga permisos para gestionar canales y roles. Error: ${error.message}` 
                        });
                    }
                    
                    // Add slot to database with channel and role ID
                    addSlot(targetUser.id, targetUser.tag, duration, category, guild.id, userChannel.id, slotRole?.id, async (err) => {
                        if (err) {
                            console.error('Database error when creating slot:', err);
                            // Clean up channel and role if database fails
                            userChannel.delete().catch(console.error);
                            if (slotRole) {
                                const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
                                if (targetMember && targetMember.roles.cache.has(slotRole.id)) {
                                    targetMember.roles.remove(slotRole).catch(console.error);
                                }
                            }
                            return interaction.editReply({ content: `❌ Failed to create VIP slot. Error: ${err.message}` });
                        }
                        
                        // Log activity
                        logActivity(guild.id, targetUser.id, 'VIP_SLOT_CREATED', `Duration: ${duration} days, Category: ${category}`);
                        
                        const embed = createAdvancedEmbed('💎 VIP Slot Created Successfully!', 0xFFD700)
                            .setDescription(`**${targetUser.tag}** has been granted a premium VIP slot!`)
                            .addFields([
                                { name: '👤 User', value: `${targetUser}`, inline: true },
                                { name: '⏰ Duration', value: formatDuration(duration), inline: true },
                                { name: '🏷️ Category', value: category, inline: true },
                                { name: '📅 Created', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                                { name: '🗓️ Expires', value: `<t:${Math.floor((Date.now() + duration * 24 * 60 * 60 * 1000) / 1000)}:F>`, inline: true },
                                { name: '🔔 VIP Limits', value: `@everyone: ${config.vip_everyone_per_week || 1}/week\n@here: ${config.vip_here_per_day || 2}/day`, inline: true },
                                { name: '💬 Channel', value: `${userChannel}`, inline: true },
                                { name: '🏆 Role', value: slotRole ? `${slotRole}` : 'None', inline: true },
                                { name: '💎 Points', value: '0', inline: true }
                            ])
                            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                            .setImage('https://media.giphy.com/media/3oz8xLlw6GHVfokaNW/giphy.gif');
                        
                        interaction.editReply({ embeds: [embed] });
                        
                        // Send enhanced welcome message to the new VIP channel
                        const welcomeEmbed = createAdvancedEmbed(`💎 Welcome to Your VIP Slot! 💎`, 0xFFD700)
                            .setDescription(`Hello ${targetUser}! 👋\n\n**💎 Your VIP Benefits:**\n• Premium personal channel for ${formatDuration(duration)}\n• ${config.vip_everyone_per_week || 1} @everyone per week\n• ${config.vip_here_per_day || 2} @here pings per day\n• Exclusive VIP role${slotRole ? ` (${slotRole.name})` : ''}\n• Enhanced point earning system\n• Priority support\n\n**Commands you can use:**\n• \`/slotinfo\` - Check your slot details\n• \`/slotstats points\` - View points leaderboard\n\nWelcome to the VIP experience! ✨`)
                            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));
                        
                        userChannel.send({ embeds: [welcomeEmbed] });
                        
                        // Send to logs channel if configured
                        if (config.logs_channel_id) {
                            const logsChannel = guild.channels.cache.get(config.logs_channel_id);
                            if (logsChannel) {
                                const logEmbed = createAdvancedEmbed('📈 VIP Slot Activity Log', 0xFFD700)
                                    .addFields([
                                        { name: 'Action', value: '💎 VIP Slot Created', inline: true },
                                        { name: 'User', value: `${targetUser.tag}`, inline: true },
                                        { name: 'Admin', value: `${user.tag}`, inline: true },
                                        { name: 'Duration', value: formatDuration(duration), inline: true },
                                        { name: 'Category', value: category, inline: true },
                                        { name: 'Channel', value: `${userChannel}`, inline: true }
                                    ]);
                                logsChannel.send({ embeds: [logEmbed] });
                            }
                        }
                    });
                });
                
            } catch (error) {
                console.error('Error creating VIP slot:', error);
                return interaction.editReply({ content: '❌ Failed to create VIP slot. Make sure the bot has proper permissions.' });
            }
        });
    }
    
    else if (commandName === 'slotconfig') {
        const subcommand = options.getSubcommand();
        
        if (subcommand === 'role') {
            const roleName = options.getString('name');
            const roleColor = options.getString('color') || '#FFD700';
            
            updateServerConfig(guild.id, 'slot_role_name', roleName, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to update role name.', ephemeral: true });
                }
                
                if (roleColor) {
                    updateServerConfig(guild.id, 'slot_role_color', roleColor, (err) => {
                        if (err) {
                            return interaction.reply({ content: '❌ Failed to update role color.', ephemeral: true });
                        }
                        
                        const embed = createAdvancedEmbed('⚙️ Role Configuration Updated', 0x00FF00)
                            .addFields([
                                { name: '🏷️ Role Name', value: roleName, inline: true },
                                { name: '🎨 Role Color', value: roleColor, inline: true }
                            ])
                            .setDescription('New slots will use these role settings.');
                        
                        interaction.reply({ embeds: [embed], ephemeral: true });
                        logActivity(guild.id, user.id, 'CONFIG_UPDATED', `Role settings: ${roleName}, ${roleColor}`);
                    });
                } else {
                    const embed = createAdvancedEmbed('⚙️ Role Configuration Updated', 0x00FF00)
                        .addFields([
                            { name: '🏷️ Role Name', value: roleName, inline: true }
                        ])
                        .setDescription('New slots will use this role name.');
                    
                    interaction.reply({ embeds: [embed], ephemeral: true });
                    logActivity(guild.id, user.id, 'CONFIG_UPDATED', `Role name: ${roleName}`);
                }
            });
        }
        
        else if (subcommand === 'limits') {
            const hereLimit = options.getInteger('here_limit');
            
            updateServerConfig(guild.id, 'max_here_per_day', hereLimit, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to update @here limit.', ephemeral: true });
                }
                
                const embed = createAdvancedEmbed('⚙️ Limits Configuration Updated', 0x00FF00)
                    .addFields([
                        { name: '🔔 Daily @here Limit', value: hereLimit.toString(), inline: true }
                    ])
                    .setDescription('This applies to all existing and new slots.');
                
                interaction.reply({ embeds: [embed], ephemeral: true });
                logActivity(guild.id, user.id, 'CONFIG_UPDATED', `@here limit: ${hereLimit}`);
            });
        }
        
        else if (subcommand === 'logs') {
            const channel = options.getChannel('channel');
            
            updateServerConfig(guild.id, 'logs_channel_id', channel.id, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to set logs channel.', ephemeral: true });
                }
                
                const embed = createAdvancedEmbed('⚙️ Logs Configuration Updated', 0x00FF00)
                    .addFields([
                        { name: '📋 Logs Channel', value: `${channel}`, inline: true }
                    ])
                    .setDescription('All slot activities will be logged here.');
                
                interaction.reply({ embeds: [embed], ephemeral: true });
                logActivity(guild.id, user.id, 'CONFIG_UPDATED', `Logs channel: ${channel.name}`);
            });
        }
    }
    
    else if (commandName === 'slotstats') {
        const type = options.getString('type') || 'overview';
        
        if (type === 'overview') {
            db.all('SELECT * FROM slots WHERE guild_id = ? AND expiry_date > ?', [guild.id, Date.now()], (err, slots) => {
                if (err) {
                    return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
                }
                
                const totalSlots = slots.length;
                const categories = {};
                let totalPoints = 0;
                
                slots.forEach(slot => {
                    categories[slot.category] = (categories[slot.category] || 0) + 1;
                    totalPoints += slot.points || 0;
                });
                
                const topCategories = Object.entries(categories)
                    .sort(([,a], [,b]) => b - a)
                    .slice(0, 5)
                    .map(([cat, count]) => `**${cat}**: ${count}`)
                    .join('\n') || 'No active slots';
                
                const embed = createAdvancedEmbed('📊 Slot System Overview', 0x0099FF)
                    .addFields([
                        { name: '👥 Active Slots', value: totalSlots.toString(), inline: true },
                        { name: '⭐ Total Points', value: totalPoints.toString(), inline: true },
                        { name: '📈 Categories', value: topCategories, inline: false }
                    ])
                    .setThumbnail(guild.iconURL({ dynamic: true }));
                
                interaction.reply({ embeds: [embed] });
            });
        }
        
        else if (type === 'active') {
            db.all('SELECT * FROM slots WHERE guild_id = ? AND expiry_date > ? ORDER BY creation_date DESC LIMIT 10', [guild.id, Date.now()], (err, slots) => {
                if (err) {
                    return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
                }
                
                if (slots.length === 0) {
                    return interaction.reply({ content: '📝 No active slots found.', ephemeral: true });
                }
                
                const slotsList = slots.map((slot, index) => {
                    const user = guild.members.cache.get(slot.user_id);
                    const daysLeft = Math.ceil((slot.expiry_date - Date.now()) / (24 * 60 * 60 * 1000));
                    return `**${index + 1}.** ${user ? user.displayName : slot.user_tag} - ${slot.category} (${daysLeft} days left)`;
                }).join('\n');
                
                const embed = createAdvancedEmbed('📋 Active Slots', 0x00AE86)
                    .setDescription(slotsList)
                    .setFooter({ text: `Showing ${slots.length} of ${slots.length} active slots` });
                
                interaction.reply({ embeds: [embed] });
            });
        }
        
        else if (type === 'points') {
            db.all('SELECT * FROM slots WHERE guild_id = ? AND expiry_date > ? ORDER BY points DESC LIMIT 10', [guild.id, Date.now()], (err, slots) => {
                if (err) {
                    return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
                }
                
                if (slots.length === 0) {
                    return interaction.reply({ content: '📝 No slots with points found.', ephemeral: true });
                }
                
                const leaderboard = slots.map((slot, index) => {
                    const user = guild.members.cache.get(slot.user_id);
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                    return `${medal} ${user ? user.displayName : slot.user_tag} - **${slot.points}** points`;
                }).join('\n');
                
                const embed = createAdvancedEmbed('🏆 Points Leaderboard', 0xFFD700)
                    .setDescription(leaderboard)
                    .setThumbnail('https://media.giphy.com/media/26u4cqiYI30juCOGY/giphy.gif');
                
                interaction.reply({ embeds: [embed] });
            });
        }
        
        else if (type === 'activity') {
            db.all('SELECT * FROM activity_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 10', [guild.id], (err, logs) => {
                if (err) {
                    return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
                }
                
                if (logs.length === 0) {
                    return interaction.reply({ content: '📝 No recent activity found.', ephemeral: true });
                }
                
                const activityList = logs.map(log => {
                    const user = guild.members.cache.get(log.user_id);
                    const timeAgo = `<t:${Math.floor(log.timestamp / 1000)}:R>`;
                    return `**${log.action}** - ${user ? user.displayName : 'Unknown User'} ${timeAgo}`;
                }).join('\n');
                
                const embed = createAdvancedEmbed('📈 Recent Activity', 0xFF6B6B)
                    .setDescription(activityList);
                
                interaction.reply({ embeds: [embed] });
            });
        }
    }
    
    else if (commandName === 'givepoints') {
        const targetUser = options.getUser('user');
        const points = options.getInteger('points');
        const reason = options.getString('reason') || 'No reason provided';
        
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            addPoints(targetUser.id, guild.id, points, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to give points.', ephemeral: true });
                }
                
                const embed = createAdvancedEmbed('⭐ Points Awarded!', 0xFFD700)
                    .addFields([
                        { name: '👤 User', value: `${targetUser}`, inline: true },
                        { name: '⭐ Points Given', value: points.toString(), inline: true },
                        { name: '💼 Admin', value: `${user}`, inline: true },
                        { name: '📝 Reason', value: reason, inline: false }
                    ])
                    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));
                
                interaction.reply({ embeds: [embed] });
                
                // Notify user in their channel
                if (slot.channel_id) {
                    const userChannel = guild.channels.cache.get(slot.channel_id);
                    if (userChannel) {
                        const notificationEmbed = createAdvancedEmbed('🎉 You Earned Points!', 0xFFD700)
                            .setDescription(`You received **${points} points** from ${user}!\n\n**Reason:** ${reason}`);
                        userChannel.send({ content: `${targetUser}`, embeds: [notificationEmbed] });
                    }
                }
                
                logActivity(guild.id, targetUser.id, 'POINTS_GIVEN', `${points} points given by ${user.tag}: ${reason}`);
            });
        });
    }
    
    else if (commandName === 'slothelp') {
        const embed = createAdvancedEmbed('🆘 Slot System Help', 0x7289DA)
            .setDescription('**Enhanced Discord Slot Bot** - Complete VIP management system')
            .addFields([
                { 
                    name: '👑 Admin Commands', 
                    value: '`/freeslot` - Create VIP slot with role & channel\n`/removeslot` - Remove user\'s slot\n`/slotconfig` - Configure bot settings\n`/givepoints` - Award points to users\n`/warn` - Warn users for violations', 
                    inline: false 
                },
                { 
                    name: '📊 Information Commands', 
                    value: '`/slotinfo` - Check slot details\n`/slotstats` - View server statistics\n`/searchslots` - 🔍 Advanced search with Meilisearch\n`/slothelp` - Show this help menu', 
                    inline: false 
                },
                { 
                    name: '🔧 Configuration Options', 
                    value: '• Custom role names and colors\n• Adjustable @here limits\n• Activity logging channel\n• Automatic role assignment\n• Points system', 
                    inline: false 
                },
                { 
                    name: '⭐ Features', 
                    value: '• Automatic role management\n• Personal VIP channels\n• @here usage tracking\n• Points leaderboard\n• Activity logs\n• Auto-moderation', 
                    inline: false 
                }
            ])
            .setFooter({ text: 'Use the commands above to manage your VIP slots!' })
            .setThumbnail(client.user.displayAvatarURL());
        
        interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === 'searchslots') {
        const query = options.getString('query');
        const categoryFilter = options.getString('category');
        
        if (!meiliClient) {
            return interaction.reply({
                content: '❌ Advanced search is not available. Meilisearch is not configured.',
                ephemeral: true
            });
        }
        
        try {
            const results = await searchSlots(query, guild.id);
            
            if (results.hits.length === 0) {
                return interaction.reply({
                    content: `🔍 No slots found for query: **${query}**${categoryFilter ? ` in category **${categoryFilter}**` : ''}`,
                    ephemeral: true
                });
            }
            
            const embed = createAdvancedEmbed('🔍 Advanced Search Results', 0x00D4AA)
                .setDescription(`Found **${results.hits.length}** slot${results.hits.length === 1 ? '' : 's'} for: **${query}**`)
                .setFooter({ text: `Powered by Meilisearch • ${results.processingTimeMs}ms` });
            
            // Add up to 8 results to avoid embed limits
            const fields = results.hits.slice(0, 8).map((hit, index) => {
                const slot = hit;
                const createdDate = new Date(slot.creation_date).toLocaleDateString();
                const expiryDate = new Date(slot.expiry_date).toLocaleDateString();
                const status = slot.expiry_date > Date.now() ? '🟢 Active' : '🔴 Expired';
                
                return {
                    name: `${index + 1}. ${slot.user_tag}`,
                    value: `**Category:** ${slot.category}\n**Status:** ${status}\n**Points:** ${slot.points || 0}\n**Created:** ${createdDate}`,
                    inline: true
                };
            });
            
            embed.addFields(fields);
            
            if (results.hits.length > 8) {
                embed.addFields({
                    name: '📋 Additional Results',
                    value: `... and ${results.hits.length - 8} more results. Use more specific search terms.`,
                    inline: false
                });
            }
            
            interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Search error:', error);
            interaction.reply({
                content: '❌ Search failed. Please try again later.',
                ephemeral: true
            });
        }
    }
    
    // Server Setup Commands
    else if (commandName === 'setupserver') {
        await interaction.deferReply();
        
        try {
            // Check if server is already set up
            getServerSetup(guild.id, async (err, setup) => {
                if (setup && setup.setup_completed) {
                    return interaction.editReply({ 
                        content: '⚠️ El servidor ya está configurado. Los canales y roles ya existen.' 
                    });
                }
                
                const setupResult = await setupDiscordServer(guild);
                await sendWelcomeMessages(setupResult);
                
                const embed = createAdvancedEmbed('🎉 ¡Servidor Configurado Exitosamente!', 0x00FF00)
                    .setDescription('Se han creado automáticamente todos los canales y roles necesarios.')
                    .addFields([
                        { name: '📋 Información', value: `<#${setupResult.rulesChannel.id}>\n<#${setupResult.welcomeChannel.id}>`, inline: true },
                        { name: '💬 General', value: `<#${setupResult.generalChannel.id}>`, inline: true },
                        { name: '✅ Vouches', value: `<#${setupResult.vouchesChannel.id}>`, inline: true },
                        { name: '👤 Roles', value: `${setupResult.memberRole}\n${setupResult.staffRole}\n${setupResult.vipRole}`, inline: true },
                        { name: '📊 Logs', value: `<#${setupResult.logsChannel.id}>`, inline: true },
                        { name: '⭐ Slots', value: 'Categoría creada para slots VIP', inline: true }
                    ])
                    .setThumbnail(guild.iconURL({ dynamic: true }));
                
                interaction.editReply({ embeds: [embed] });
                
                // Log the setup
                logActivity(guild.id, user.id, 'SERVER_SETUP', 'Discord server automatically configured');
            });
            
        } catch (error) {
            console.error('Error setting up server:', error);
            return interaction.editReply({ 
                content: '❌ Error al configurar el servidor. Asegúrate de que el bot tenga permisos de Administrador.' 
            });
        }
    }
    
    else if (commandName === 'vouch') {
        const targetUser = options.getUser('user');
        const service = options.getString('service');
        const rating = options.getInteger('rating');
        const comment = options.getString('comment') || 'Sin comentarios adicionales';
        
        // Check if user has VIP role
        const member = guild.members.cache.get(user.id);
        const hasVipRole = member.roles.cache.some(role => role.name.toLowerCase().includes('vip') || role.name.toLowerCase().includes('slot'));
        
        if (!hasVipRole) {
            return interaction.reply({ 
                content: '❌ Solo los usuarios VIP pueden crear vouches. Obtén un slot VIP primero.', 
                ephemeral: true 
            });
        }
        
        // Get vouches channel
        getServerSetup(guild.id, async (err, setup) => {
            if (err || !setup || !setup.vouches_channel_id) {
                return interaction.reply({ 
                    content: '❌ Canal de vouches no configurado. Use `/setupserver` primero.', 
                    ephemeral: true 
                });
            }
            
            const vouchesChannel = guild.channels.cache.get(setup.vouches_channel_id);
            if (!vouchesChannel) {
                return interaction.reply({ 
                    content: '❌ Canal de vouches no encontrado.', 
                    ephemeral: true 
                });
            }
            
            // Create vouch embed
            const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
            const vouchEmbed = createAdvancedEmbed('✅ Nuevo Vouch', 0x00FF00)
                .addFields([
                    { name: '👤 Usuario', value: `${targetUser}`, inline: true },
                    { name: '📝 Servicio', value: service, inline: true },
                    { name: '⭐ Calificación', value: `${stars} (${rating}/5)`, inline: true },
                    { name: '💬 Comentario', value: comment, inline: false },
                    { name: '✍️ Vouch por', value: `${user}`, inline: true },
                    { name: '📅 Fecha', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `Vouch ID: ${Date.now()}` });
            
            try {
                await vouchesChannel.send({ embeds: [vouchEmbed] });
                
                const confirmEmbed = createAdvancedEmbed('✅ Vouch Creado', 0x00FF00)
                    .setDescription(`Tu vouch para ${targetUser} ha sido publicado en ${vouchesChannel}.`);
                
                interaction.reply({ embeds: [confirmEmbed], ephemeral: true });
                
                // Log activity
                logActivity(guild.id, user.id, 'VOUCH_CREATED', `Vouch created for ${targetUser.tag} - Rating: ${rating}/5`);
                
            } catch (error) {
                console.error('Error sending vouch:', error);
                return interaction.reply({ 
                    content: '❌ Error al enviar el vouch.', 
                    ephemeral: true 
                });
            }
        });
    }
    
    else if (commandName === 'serverinfo') {
        getServerSetup(guild.id, (err, setup) => {
            if (err) {
                return interaction.reply({ content: '❌ Error de base de datos.', ephemeral: true });
            }
            
            if (!setup || !setup.setup_completed) {
                const embed = createAdvancedEmbed('📋 Información del Servidor', 0xFF6B6B)
                    .setDescription('⚠️ **El servidor no está configurado automáticamente.**\n\nUsa `/setupserver` para configurar canales y roles automáticamente.')
                    .addFields([
                        { name: '🔧 Estado', value: 'No configurado', inline: true },
                        { name: '📊 Miembros', value: guild.memberCount.toString(), inline: true },
                        { name: '📅 Creado', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true }
                    ]);
                
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            
            // Count active slots
            getAllSlots(guild.id, (err, slots) => {
                const activeSlots = slots ? slots.length : 0;
                
                const embed = createAdvancedEmbed('📋 Información del Servidor', 0x00AE86)
                    .setDescription('✅ **Servidor configurado automáticamente**')
                    .addFields([
                        { name: '👥 Miembros', value: guild.memberCount.toString(), inline: true },
                        { name: '⭐ Slots VIP Activos', value: activeSlots.toString(), inline: true },
                        { name: '📅 Configurado', value: setup.setup_completed ? '✅ Sí' : '❌ No', inline: true },
                        { name: '👋 Canal Bienvenida', value: setup.welcome_channel_id ? `<#${setup.welcome_channel_id}>` : 'No configurado', inline: true },
                        { name: '📜 Canal Reglas', value: setup.rules_channel_id ? `<#${setup.rules_channel_id}>` : 'No configurado', inline: true },
                        { name: '✅ Canal Vouches', value: setup.vouches_channel_id ? `<#${setup.vouches_channel_id}>` : 'No configurado', inline: true }
                    ])
                    .setThumbnail(guild.iconURL({ dynamic: true }));
                
                interaction.reply({ embeds: [embed], ephemeral: true });
            });
        });
    }
    
    else if (commandName === 'slotinfo') {
        const targetUser = options.getUser('user') || user;
        
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            // Get server config for @here limits
            getServerConfig(guild.id, (err, config) => {
                const maxHere = config ? config.max_here_per_day : 2;
                const daysLeft = Math.ceil((slot.expiry_date - Date.now()) / (24 * 60 * 60 * 1000));
                
                // Get today's @here usage
                getHereUsage(targetUser.id, guild.id, (err, usage) => {
                    const todayUsage = usage ? usage.count : 0;
                    const remainingHere = Math.max(0, maxHere - todayUsage);
                    
                    // Get role info
                    const role = slot.role_id ? guild.roles.cache.get(slot.role_id) : null;
                    
                    const embed = createAdvancedEmbed(`💬 ${targetUser.displayName}'s VIP Slot`, 0x00AE86)
                        .setDescription(`**Status:** ${daysLeft > 0 ? '✅ Active' : '❌ Expired'}\n**Time Remaining:** ${daysLeft} days`)
                        .addFields([
                            { name: '👤 User', value: `${targetUser}`, inline: true },
                            { name: '⏰ Days Left', value: daysLeft > 0 ? `${daysLeft} days` : 'Expired', inline: true },
                            { name: '🏷️ Category', value: slot.category, inline: true },
                            { name: '📅 Created', value: `<t:${Math.floor(slot.creation_date / 1000)}:F>`, inline: true },
                            { name: '🗓️ Expires', value: `<t:${Math.floor(slot.expiry_date / 1000)}:F>`, inline: true },
                            { name: '⭐ Points', value: (slot.points || 0).toString(), inline: true },
                            { name: '🔔 @here Usage Today', value: `${todayUsage}/${maxHere} used\n${remainingHere} remaining`, inline: true },
                            { name: '💬 Channel', value: slot.channel_id ? `<#${slot.channel_id}>` : 'No channel', inline: true },
                            { name: '🏆 Role', value: role ? `${role}` : 'No role', inline: true }
                        ])
                        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                        .setColor(daysLeft > 7 ? 0x00FF00 : daysLeft > 3 ? 0xFFFF00 : 0xFF0000);
                    
                    interaction.reply({ embeds: [embed] });
                });
            });
        });
    }
    
    else if (commandName === 'removeslot') {
        const targetUser = options.getUser('user');
        
        await interaction.deferReply();
        
        // Get slot info first to find channel and role
        getSlot(targetUser.id, guild.id, async (err, slot) => {
            if (err) {
                return interaction.editReply({ content: '❌ Database error occurred.' });
            }
            
            if (!slot) {
                return interaction.editReply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`
                });
            }
            
            let deletedChannel = false;
            let removedRole = false;
            
            // Delete channel if it exists
            if (slot.channel_id) {
                try {
                    const channel = guild.channels.cache.get(slot.channel_id);
                    if (channel) {
                        await channel.delete(`Removing slot channel for ${targetUser.tag}`);
                        deletedChannel = true;
                    }
                } catch (error) {
                    console.error('Error deleting channel:', error);
                }
            }
            
            // Remove role if it exists
            if (slot.role_id) {
                try {
                    const role = guild.roles.cache.get(slot.role_id);
                    const member = await guild.members.fetch(targetUser.id).catch(() => null);
                    if (role && member && member.roles.cache.has(role.id)) {
                        await member.roles.remove(role, `Slot removed by ${user.tag}`);
                        removedRole = true;
                    }
                } catch (error) {
                    console.error('Error removing role:', error);
                }
            }
            
            // Remove from database
            removeSlot(targetUser.id, guild.id, (err) => {
                if (err) {
                    return interaction.editReply({ content: '❌ Failed to remove slot from database.' });
                }
                
                const embed = createAdvancedEmbed('✅ Slot Removed Successfully', 0xFF0000)
                    .addFields([
                        { name: '👤 User', value: `${targetUser.tag}`, inline: true },
                        { name: '💬 Channel', value: deletedChannel ? '✅ Deleted' : '❌ Not found', inline: true },
                        { name: '🏆 Role', value: removedRole ? '✅ Removed' : '❌ Not found', inline: true },
                        { name: '💼 Admin', value: `${user.tag}`, inline: true }
                    ])
                    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));
                
                interaction.editReply({ embeds: [embed] });
                
                // Log activity
                logActivity(guild.id, targetUser.id, 'SLOT_REMOVED', `Removed by ${user.tag}`);
                
                // Send to logs channel if configured
                getServerConfig(guild.id, (err, config) => {
                    if (!err && config.logs_channel_id) {
                        const logsChannel = guild.channels.cache.get(config.logs_channel_id);
                        if (logsChannel) {
                            const logEmbed = createAdvancedEmbed('📋 Slot Activity Log', 0xFF6B6B)
                                .addFields([
                                    { name: 'Action', value: 'Slot Removed', inline: true },
                                    { name: 'User', value: `${targetUser.tag}`, inline: true },
                                    { name: 'Admin', value: `${user.tag}`, inline: true }
                                ]);
                            logsChannel.send({ embeds: [logEmbed] });
                        }
                    }
                });
            });
        });
    }
    
    else if (commandName === 'addhere') {
        const targetUser = options.getUser('user');
        
        // Check if user has an active slot
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            incrementHereUsage(targetUser.id, guild.id, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to add @here usage.', ephemeral: true });
                }
                
                // Get server config for proper limits
                getServerConfig(guild.id, (configErr, config) => {
                    if (configErr) {
                        return interaction.reply({ content: '❌ Failed to get server configuration.', ephemeral: true });
                    }
                    
                    // Check updated usage
                    getHereUsage(targetUser.id, guild.id, (err, usage) => {
                        const todayUsage = usage ? usage.count : 0;
                        const maxHere = config.max_here_per_day || 1;
                        const remaining = Math.max(0, maxHere - todayUsage);
                        
                        // Send notification to the user about their @here usage
                        const userChannel = guild.channels.cache.get(slot.channel_id);
                        if (userChannel) {
                            userChannel.send(`📢 ${targetUser}, you have **${remaining}/${maxHere} @here** left today. (Added manually by admin)`);
                        } else {
                            // Send in current channel if user channel doesn't exist
                            interaction.channel.send(`📢 ${targetUser}, you have **${remaining}/${maxHere} @here** left today. (Added manually by admin)`);
                        }
                        
                        interaction.reply({ 
                            content: `✅ Added @here usage to ${targetUser.tag}. Today's usage: ${todayUsage}/${maxHere}. Remaining: ${remaining}`, 
                            ephemeral: true 
                        });
                    });
                });
            });
        });
    }
    
    else if (commandName === 'addevryone') {
        const targetUser = options.getUser('user');
        
        // Check if user has an active VIP slot
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            // Check if it's a VIP slot
            const isVipSlot = slot.category.toLowerCase().includes('vip') || slot.category.toLowerCase().includes('💎');
            if (!isVipSlot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have a VIP slot. @everyone usage is only for VIP slots.`, 
                    ephemeral: true 
                });
            }
            
            incrementWeeklyMentions(targetUser.id, guild.id, 'vip', 'everyone', (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to add @everyone usage.', ephemeral: true });
                }
                
                // Get server config for proper limits
                getServerConfig(guild.id, (configErr, config) => {
                    if (configErr) {
                        return interaction.reply({ content: '❌ Failed to get server configuration.', ephemeral: true });
                    }
                    
                    // Check updated weekly usage
                    getWeeklyMentionUsage(targetUser.id, guild.id, 'vip', (err, weeklyUsage) => {
                        const everyoneUsed = weeklyUsage ? weeklyUsage.everyone_count : 0;
                        const maxEveryone = config.vip_everyone_per_week || 1;
                        const remaining = Math.max(0, maxEveryone - everyoneUsed);
                        
                        // Send notification to the user about their @everyone usage
                        const userChannel = guild.channels.cache.get(slot.channel_id);
                        if (userChannel) {
                            userChannel.send(`📢 ${targetUser}, you have **${remaining}/${maxEveryone} @everyone** left this week. (Added manually by admin)`);
                        } else {
                            // Send in current channel if user channel doesn't exist
                            interaction.channel.send(`📢 ${targetUser}, you have **${remaining}/${maxEveryone} @everyone** left this week. (Added manually by admin)`);
                        }
                        
                        interaction.reply({ 
                            content: `✅ Added @everyone usage to ${targetUser.tag}. This week's usage: ${everyoneUsed}/${maxEveryone}. Remaining: ${remaining}`, 
                            ephemeral: true 
                        });
                    });
                });
            });
        });
    }
    
    else if (commandName === 'warn') {
        const targetUser = options.getUser('user');
        
        // Check if user has an active slot
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            addWarning(targetUser.id, guild.id, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to add warning.', ephemeral: true });
                }
                
                // Check warning count
                getWarnings(targetUser.id, guild.id, async (err, warnings) => {
                    const warningCount = warnings ? warnings.warning_count : 0;
                    
                    if (warningCount >= 2) {
                        // Delete channel if it exists
                        if (slot.channel_id) {
                            try {
                                const channel = guild.channels.cache.get(slot.channel_id);
                                if (channel) {
                                    await channel.delete(`Slot revoked for ${targetUser.tag} - excessive @here usage`);
                                }
                            } catch (error) {
                                console.error('Error deleting channel:', error);
                            }
                        }
                        
                        // Remove slot after 2 warnings
                        removeSlot(targetUser.id, guild.id, () => {
                            interaction.reply({ 
                                content: `🚫 ${targetUser.tag}'s slot has been **revoked** due to excessive @here usage after **${warningCount} warnings**.`
                            });
                        });
                    } else {
                        interaction.reply({ 
                            content: `⚠️ Warning **${warningCount}/2** issued to ${targetUser.tag} for excessive @here usage. Next warning will result in **slot revocation**.`
                        });
                    }
                });
            });
        });
    }
    
    else if (commandName === 'hereused') {
        const targetUser = options.getUser('user');
        
        // Check if user has an active slot
        getSlot(targetUser.id, guild.id, (err, slot) => {
            if (err) {
                return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
            }
            
            if (!slot) {
                return interaction.reply({ 
                    content: `❌ ${targetUser.tag} doesn't have an active slot.`, 
                    ephemeral: true 
                });
            }
            
            // Increment @here usage
            incrementHereUsage(targetUser.id, guild.id, (err) => {
                if (err) {
                    return interaction.reply({ content: '❌ Failed to track @here usage.', ephemeral: true });
                }
                
                // Get updated usage count
                getHereUsage(targetUser.id, guild.id, async (err, usage) => {
                    if (err) {
                        return interaction.reply({ content: '❌ Failed to get usage count.', ephemeral: true });
                    }
                    
                    // Get server config for limits
                    getServerConfig(guild.id, (configErr, config) => {
                        const maxHere = config ? config.max_here_per_day : 2;
                        const todayUsage = usage ? usage.count : 0;
                        const remaining = Math.max(0, maxHere - todayUsage);
                        
                        // Send enhanced notification to user
                        let notificationEmbed;
                        if (todayUsage <= maxHere) {
                            if (remaining > 0) {
                                notificationEmbed = createAdvancedEmbed('📢 @here Usage Tracked', 0x00FF00)
                                    .setDescription(`${targetUser}, you used @here successfully!`)
                                    .addFields([
                                        { name: '📈 Today\'s Usage', value: `${todayUsage}/${maxHere}`, inline: true },
                                        { name: '✅ Remaining', value: remaining.toString(), inline: true },
                                        { name: '⭐ Points Earned', value: '+1', inline: true }
                                    ]);
                                
                                // Award point for proper usage
                                addPoints(targetUser.id, guild.id, 1, () => {});
                            } else {
                                notificationEmbed = createAdvancedEmbed('⚠️ Daily Limit Reached', 0xFFFF00)
                                    .setDescription(`${targetUser}, you've reached your daily @here limit!`)
                                    .addFields([
                                        { name: '📈 Usage', value: `${todayUsage}/${maxHere}`, inline: true },
                                        { name: '❌ Remaining', value: '0', inline: true },
                                        { name: '🔄 Reset', value: 'Midnight UTC', inline: true }
                                    ]);
                            }
                        } else {
                            notificationEmbed = createAdvancedEmbed('⚠️ Limit Exceeded - Warning!', 0xFF0000)
                                .setDescription(`${targetUser}, you have **exceeded** your daily @here limit!`)
                                .addFields([
                                    { name: '🚨 Violation', value: `${todayUsage}/${maxHere} (Exceeded)`, inline: true },
                                    { name: '📝 Action', value: 'Warning Issued', inline: true },
                                    { name: '🚫 Penalty', value: '-5 Points', inline: true }
                                ]);
                            
                            // Deduct points for violation
                            addPoints(targetUser.id, guild.id, -5, () => {});
                            
                            // Auto-issue warning for excessive usage
                            addWarning(targetUser.id, guild.id, (err) => {
                                if (!err) {
                                    getWarnings(targetUser.id, guild.id, async (err, warnings) => {
                                        if (!err) {
                                            const warningCount = warnings ? warnings.warning_count : 0;
                                            if (warningCount >= 2) {
                                                // Auto-revoke slot
                                                if (slot.channel_id) {
                                                    try {
                                                        const channel = guild.channels.cache.get(slot.channel_id);
                                                        if (channel) {
                                                            await channel.delete(`Auto-revoked: ${targetUser.tag} exceeded @here limit`);
                                                        }
                                                    } catch (error) {
                                                        console.error('Error deleting channel:', error);
                                                    }
                                                }
                                                
                                                removeSlot(targetUser.id, guild.id, () => {
                                                    interaction.followUp({ 
                                                        content: `🚫 ${targetUser}, your **slot has been revoked** due to excessive @here usage after **${warningCount} warnings**.`
                                                    }).catch(console.error);
                                                });
                                            } else {
                                                interaction.channel.send(`⚠️ ${targetUser}, this is **warning ${warningCount}/2**. Your slot will be **revoked** after the next warning.`);
                                            }
                                        }
                                    });
                                }
                            });
                        }
                        
                        // Send notification to user's channel or current channel
                        (async () => {
                            try {
                                if (slot.channel_id) {
                                    const userChannel = guild.channels.cache.get(slot.channel_id);
                                    if (userChannel) {
                                        await userChannel.send({ embeds: [notificationEmbed] });
                                    } else {
                                        await interaction.channel.send({ embeds: [notificationEmbed] });
                                    }
                                } else {
                                    await interaction.channel.send({ embeds: [notificationEmbed] });
                                }
                            } catch (error) {
                                console.error('Error sending notification:', error);
                            }
                        })();
                        
                        // Confirm to admin
                        interaction.reply({ 
                            content: `✅ Tracked @here usage for ${targetUser.tag}. Usage: **${todayUsage}/${maxHere}**`, 
                            ephemeral: true 
                        });
                    });
                });
            });
        });
    }
    
    else if (commandName === 'fillchannels') {
        await interaction.deferReply();
        
        try {
            const guild = interaction.guild;
            let channelsUpdated = 0;
            
            // Define comprehensive channel content for selling slots - SHORTENED for Discord limits
            const channelContents = {
                // Welcome Section
                welcome: `🎉 **WELCOME TO PREMIUM SELLING SLOTS!** 🎉

**💎 VIP MEMBERSHIP - €5/MONTH**
✨ 3 slots, priority support, exclusive channels, VIP events

**🚀 Getting Started:**
1️⃣ Read 📋 rules completely 
2️⃣ Build reputation with vouches
3️⃣ Apply for slot in applications
4️⃣ Start selling safely!

**⚠️ ZERO TOLERANCE FOR SCAMMERS**
We eliminate ALL fraudsters instantly!

🔥 Ready to join Europe's #1 selling community?`,

                'info-slots': `ℹ️ **SLOT INFORMATION** ℹ️

**📊 Current Status:**
• Standard Slots: 156/300 active
• VIP Slots: 47/100 (€5/month)
• Success Rate: 98.7%

**⏱️ Processing Times:**
• Standard: 48-72 hours
• VIP: 12-24 hours priority

**💰 What You Can Sell:**
• Gaming accounts & items
• Digital services & software  
• Social media services
• Educational content
• Any legal products!

**Contact staff for slot applications!**`,

                // VIP Section
                vip: `💎 **VIP EXCLUSIVE LOUNGE** 💎

**Welcome VIP Members! (€5/month)**

**✨ Your Benefits:**
• 3 simultaneous slots
• Priority 1-hour support
• Exclusive deals & channels
• 5 @here permissions/day
• Monthly €500 giveaways

**📈 VIP Success Stats:**
• Average earnings: €3,247/month
• Transaction success: 98.7%
• Satisfaction rate: 99.1%

**🔥 VIP members earn 3.4x more!**
Welcome to the premium experience!`,

                // Slots Section  
                slotsfree: `🆓 **FREE SLOTS AVAILABLE!** 🆓

**How to Get Your Slot:**

**📝 Requirements:**
• 5+ legitimate vouches
• Clean reputation check
• Proof of products/services
• Professional application

**📋 Application Format:**
\`Username: @you
Product: [what you sell]  
Experience: [how long]
Vouches: [links/proof]
Why you: [your pitch]\`

**⚠️ NO SCAMMERS ACCEPTED**
Quality sellers only!`,

                // Information Section
                reglas: `🔒 **SERVER RULES** 🔒

**💎 VIP: €5/month for premium benefits**

**1. NO SCAMMING - ZERO TOLERANCE**
• Instant permanent ban + blacklist
• All sales must be vouched
• Proof required for transactions

**2. Professional Standards**
• 1 slot per user (VIP: 3 slots)
• English in main channels
• Respectful communication only

**3. Consequences**
• Scamming = PERMANENT BAN
• Fake vouches = INSTANT REMOVAL
• Rule violations = Progressive discipline

⚠️ **SCAMMERS ELIMINATED IMMEDIATELY**`,

                bienvenida: `👋 **WELCOME MESSAGE** 👋

**🌟 Professional Selling Environment**
• 5000+ trusted members
• 99.8% scam prevention
• 24/7 staff support
• €2M+ monthly volume

**💎 VIP Benefits (€5/month):**
• 3x more slots
• Priority support
• Exclusive opportunities
• Higher earnings potential

**🛡️ We Protect You:**
• Advanced fraud detection
• Verified seller community
• Legal action support
• Instant scammer bans

**Ready to start earning safely?**`,

                anuncios: `📢 **ANNOUNCEMENTS** 📢

**🔥 Latest Updates:**
• VIP membership launched (€5/month)
• AI anti-scam system active
• 99.9% fraud prevention rate
• €500 monthly VIP giveaway

**📈 Server Stats:**
• Members: 5,247 growing daily
• Successful sales: 12,847+  
• Scammers banned: 312
• Customer satisfaction: 98.2%

**⚠️ Security Alert:**
All scammers are eliminated!
Report suspicious activity immediately.

**🎯 VIP members get exclusive deals!**`,

                // General Section
                general: `💬 **GENERAL CHAT** 💬

**Welcome to our selling community!**

**💎 VIP Members (€5/month):**
Show your exclusive status here!

**🔥 Discussion Topics:**
• Market trends & opportunities
• Success stories & tips
• Security & safety advice
• Business growth strategies

**Guidelines:**
• Professional communication
• No direct advertising
• Help new members
• Report suspicious activity

**Let's build successful businesses together!**`,

                comandos: `🤖 **BOT COMMANDS** 🤖

**📊 For Everyone:**
• \`/slotinfo\` - Check slot status
• \`/vouch @user\` - Leave feedback
• \`/serverinfo\` - Server statistics

**💎 VIP Exclusive (€5/month):**
• \`/vipstats\` - Advanced analytics
• \`/prioritysupport\` - 1h response
• \`/vipdeals\` - Exclusive offers

**🛡️ Admin Only:**
• \`/freeslot @user\` - Assign slots
• \`/removeslot @user\` - Remove slots
• \`/warn @user\` - Issue warnings

**Test commands here freely!**`,

                // Vouches Section
                vouches: `✅ **VOUCHES & REPUTATION** ✅

**📝 Vouch Format:**
\`[+1/-1] @username
Product: [item purchased]
Price: €[amount]
Rating: ⭐⭐⭐⭐⭐
Review: [detailed experience]\`

**🛡️ Security:**
• All vouches verified by staff
• Fake vouches = INSTANT BAN
• AI detection system active
• Cross-platform checking

**Recent Verified Vouches:**
[+1] @TrustedSeller - Great service! ⭐⭐⭐⭐⭐
[+1] @ReliableDealer - Fast delivery! ⭐⭐⭐⭐⭐

**Build your reputation honestly!**`,

                // Staff Section
                'staff-chat': `👥 **STAFF COORDINATION** 👥

**Daily Responsibilities:**
• Process slot applications
• Investigate scam reports  
• Monitor transactions
• Support VIP members
• Maintain security

**Performance Metrics:**
• Response time: 3.7h avg
• VIP response: 47min avg
• Case resolution: 94.3%
• Member satisfaction: 97.8%

**Current Priority:**
• 13 slot applications pending
• 2 investigations active
• VIP support: All resolved

**Working together for community safety!**`,

                logs: `📊 **ACTIVITY LOGS** 📊

**Recent Activity:**
\`[14:23] VIP upgrade: @NewMember
[14:22] Slot assigned: @ApprovedSeller  
[14:21] Warning: @RuleViolator
[14:19] Scammer banned: @FraudAttempt
[14:18] Vouch verified: Sale confirmed\`

**Daily Stats:**
• New members: 23
• VIP upgrades: 7
• Transactions: 89
• Scams blocked: 3
• Processing time: 47min avg

**System Status:** 🟢 All optimal
**Security Level:** 🟢 Low threat

**All activity monitored for safety**`,

                // Additional channels for comprehensive server
                rules: `🔒 **SERVER RULES** 🔒

**💎 VIP MEMBERSHIP: €5/MONTH**

**1. ZERO TOLERANCE FOR SCAMMING**
• Scam attempt = INSTANT PERMANENT BAN
• All sales must be vouched
• Proof required for all transactions
• Staff verify high-value deals

**2. Selling Standards**
• 1 slot per user (VIP: 3 slots)
• Legitimate products only
• Professional communication
• Use designated channels

**3. Consequences**
• Scamming = PERMANENT BAN + BLACKLIST
• Fake vouches = IMMEDIATE REMOVAL
• Rule violations = Progressive discipline

⚠️ **SCAMMERS ELIMINATED IMMEDIATELY**`,

                'slot-applications': `📝 **SLOT APPLICATIONS** 📝

**How to Apply for Your Selling Slot:**

**📋 Application Format:**
\`**Username:** @YourName
**What you sell:** [Products/Services]
**Experience:** [Time selling online]
**Vouches:** [Min 5 required + links]
**Proof:** [Screenshots of inventory]
**Why approve you:** [Your pitch]\`

**✅ Requirements:**
• 5+ legitimate vouches minimum
• Clean reputation (no scam reports)
• Proof of legitimate business
• Professional application

**⏱️ Processing:**
• Standard: 48-72 hours
• VIP: 12-24 hours (€5/month)

**Apply here to start selling!**`,

                'approved-applications': `✅ **APPROVED APPLICATIONS** ✅

**🎉 Welcome Our New Verified Sellers!**

**Recent Approvals:**
• @NewSeller1 - Gaming Accounts (VIP)
• @NewSeller2 - Digital Services  
• @NewSeller3 - Software Tools (VIP)
• @NewSeller4 - Social Media Services

**📊 Approval Statistics:**
• Applications this month: 247
• Approved: 156 (63.2% success rate)
• VIP approvals: 34 (faster processing)

**🏆 Success Tips:**
• Maintain quality service
• Build positive reputation  
• Consider VIP upgrade (€5/month)

**Congratulations new sellers!**`,

                'denied-applications': `❌ **DENIED APPLICATIONS** ❌

**Common Denial Reasons:**

**🚫 Insufficient Vouches (67%)**
• Less than 5 legitimate vouches
• Fake or unverifiable vouches
• Poor quality references

**⚠️ Background Issues (18%)**
• Found on scammer blacklists
• Negative reputation elsewhere
• Failed verification process

**📝 Poor Application (15%)**
• Incomplete information
• Unprofessional presentation
• Missing required proof

**🔄 How to Improve:**
• Build legitimate vouches first
• Clean up reputation issues
• Complete professional application
• Wait required time before reapply

**Learn and try again!**`,

                faq: `❓ **FREQUENTLY ASKED QUESTIONS** ❓

**💎 VIP MEMBERSHIP (€5/month)**
**Q: What does VIP include?**
A: 3 slots, 1-hour support, exclusive deals, priority processing

**Q: How to upgrade to VIP?**
A: Contact staff with payment method

**💰 SELLING**
**Q: How to start selling?**
A: Get 5+ vouches, apply for slot, get approved

**Q: What can I sell?**
A: Any legal products - accounts, software, services, courses

**🛡️ SECURITY**
**Q: How are scammers prevented?**
A: AI detection, background checks, staff monitoring

**Q: What if I get scammed?**
A: Report immediately - scammer gets permanent ban

**More questions? Ask staff!**`,

                'market-trends': `📈 **MARKET TRENDS & OPPORTUNITIES** 📈

**🔥 Hot Categories This Month:**
1️⃣ Gaming Accounts (34% of sales)
2️⃣ Social Media Services (28%)
3️⃣ Software & Tools (22%)
4️⃣ Educational Content (11%)
5️⃣ Digital Services (5%)

**💰 Average Prices:**
• Gaming Accounts: €150-€500
• Software Licenses: €50-€200
• Social Media: €25-€150
• Courses: €30-€100

**📊 Market Insights:**
• Holiday season demand up 35%
• VIP sellers earn 3.4x more
• Repeat customers: 78.6%
• Success rate: 98.7%

**🎯 Opportunities for sellers!**`,

                'success-stories': `🏆 **SUCCESS STORIES** 🏆

**💎 VIP Success Stories:**

**@VIPSeller1 (VIP Member):**
"Made €15,000 this month! VIP benefits are incredible - priority support and exclusive deals made the difference!"

**@TopPerformer (VIP Member):**
"From €500/month to €8,000/month after VIP upgrade. The 3 slots and priority processing changed everything!"

**@NewSuccess:**
"Started 3 months ago with 0 vouches. Now I have 50+ vouches and earning €2,500/month consistently!"

**📈 Average Results:**
• VIP members: €3,247/month average
• Standard sellers: €987/month average
• Success rate: 98.7% positive outcomes

**Your success story could be next!**`,

                'payment-methods': `💳 **PAYMENT METHODS & SECURITY** 💳

**✅ Accepted Payment Methods:**
• PayPal (Buyer protection)
• Cryptocurrency (Bitcoin, Ethereum)
• Bank transfers (Verified accounts)
• Wise/Revolut
• Gift cards (Verified sellers only)

**🛡️ Security Guidelines:**
• Always use goods & services on PayPal
• Request proof before payment
• Start small with new sellers
• Use middleman for high values (€500+)
• Screenshot all conversations

**⚠️ Red Flags:**
• Friends & family only requests
• Unusually low prices
• Pressure for immediate payment
• No vouches or new accounts

**Stay safe while trading!**`,

                'middleman-services': `🤝 **MIDDLEMAN SERVICES** 🤝

**Professional Transaction Protection**

**When to Use Middleman:**
• High-value deals (€500+)
• New/unverified sellers
• Cross-platform transactions
• Bulk purchases
• Risky payment methods

**📋 Process:**
1️⃣ Both parties agree to use MM
2️⃣ Buyer sends payment to MM
3️⃣ Seller provides product/service
4️⃣ MM verifies everything works
5️⃣ MM releases payment to seller

**💰 Fees:**
• €0-€100: €5 fee
• €100-€500: €10 fee  
• €500+: 2% fee

**🛡️ 100% Protection Guaranteed**
Contact staff to arrange MM service!`,

                'giveaways-events': `🎁 **GIVEAWAYS & EVENTS** 🎁

**🔥 Current Events:**

**💎 VIP Monthly Giveaway:**
• Prize Pool: €500
• All VIP members auto-entered
• Winner announced monthly
• Next drawing: Dec 31st

**🎉 Weekly Community Events:**
• Monday: New seller spotlight
• Wednesday: Success story sharing  
• Friday: Market trend analysis
• Sunday: VIP exclusive deals

**🏆 Special Competitions:**
• Best vouches contest
• Top seller recognition
• Community helper awards
• Referral bonuses

**📅 Upcoming:**
• Holiday season bonuses
• New Year mega giveaway
• VIP exclusive workshop

**Join the excitement!**`,

                'reports-support': `🚨 **REPORTS & SUPPORT** 🚨

**How to Report Issues:**

**🚫 Scam Reports (URGENT):**
• Use this format: @Username + evidence
• Include screenshots/proof
• Staff respond within 1 hour
• Scammer gets instant ban

**⚠️ Rule Violations:**
• Spam, inappropriate behavior
• Fake vouches or manipulation
• Harassment or threats
• Technical issues

**📞 Support Channels:**
• General support: 4-8 hour response
• VIP support: 1-hour guarantee (€5/month)
• Emergency: Ping staff directly
• Technical: Bot/server issues

**🛡️ We Take Action:**
• 99.1% scam prevention rate
• Average response: 47 minutes
• 100% investigation completion

**Help keep our community safe!**`,

                'server-boosts': `🚀 **SERVER BOOSTS & PERKS** 🚀

**Current Boost Level: 2**
**Boosters: 14 amazing members!**

**🎁 Boost Perks:**
• Higher quality voice channels
• Custom server banner
• More emoji slots
• Better file upload limit
• Priority support queue

**💎 VIP + Boost Combo:**
Get VIP (€5/month) + Boost for ultimate experience!

**🏆 Booster Benefits:**
• Special booster role
• Exclusive booster chat
• Recognition in announcements
• Bonus entries in giveaways
• Staff appreciation

**Thank you to our boosters:**
@Booster1, @Booster2, @Booster3...

**Boost us to show support!**`,

                'partnerships': `🤝 **PARTNERSHIPS & AFFILIATES** 🤝

**Our Trusted Partners:**

**🌐 Partner Servers:**
• 50+ verified trading communities
• Shared scammer blacklists
• Cross-platform security
• Member referral programs

**💼 Business Partners:**
• Payment processors
• Legal support services
• Anti-fraud companies
• Marketing platforms

**🔗 Affiliate Programs:**
• Refer sellers: €10 bonus per approval
• Partner server: Revenue sharing
• Tool partnerships: Exclusive deals
• VIP referrals: 1 month free

**📊 Partnership Benefits:**
• Enhanced security network
• Expanded opportunities  
• Better fraud prevention
• Increased member safety

**Want to partner? Contact staff!**`
            };
            
            // Find and update each channel
            const channels = guild.channels.cache;
            
            for (const [channelName, content] of Object.entries(channelContents)) {
                const channel = channels.find(ch => 
                    ch.name.includes(channelName.replace('-', '')) || 
                    ch.name.includes(channelName) ||
                    ch.name === channelName
                );
                
                if (channel && channel.isTextBased()) {
                    try {
                        await channel.send(content);
                        channelsUpdated++;
                    } catch (error) {
                        console.error(`Error sending to ${channelName}:`, error);
                    }
                }
            }
            
            await interaction.editReply({
                content: `✅ **Successfully filled ${channelsUpdated} channels with premium content!**\n\n🔥 **Features Added:**\n• VIP membership info (€5/month)\n• Anti-scam policies\n• Professional selling environment\n• Comprehensive channel content\n\n💎 Ready to use /fillchannels command!`
            });
            
        } catch (error) {
            console.error('Error filling channels:', error);
            await interaction.editReply({
                content: '❌ Error occurred while filling channels. Please try again.'
            });
        }
    }
    
    else if (commandName === 'invitepoints') {
        const targetUser = options.getUser('user') || user;
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        
        if (targetUser !== user && !isAdmin) {
            return interaction.reply({ content: '❌ You can only check your own points or be an admin.', ephemeral: true });
        }
        
        getInvitePoints(targetUser.id, guild.id, (err, data) => {
            if (err) {
                return interaction.reply({ content: '❌ Error retrieving invitation points.', ephemeral: true });
            }
            
            const embed = createAdvancedEmbed('🎉 Invitation Points', 0xFFD700)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields([
                    { name: '💎 Available Points', value: `**${data.points}** points`, inline: true },
                    { name: '📈 Total Invites', value: `**${data.total_invites}** invites`, inline: true },
                    { name: '🆓 Can Redeem', value: `**${data.points}** days of free slots`, inline: true }
                ])
                .setDescription(`${targetUser.toString()}'s invitation rewards\n\n💡 **Tip:** Use \`/redeemslot\` to exchange points for free slots!`);
            
            interaction.reply({ embeds: [embed] });
        });
    }
    
    else if (commandName === 'redeemslot') {
        const days = options.getInteger('days');
        const category = options.getString('category');
        const channelName = options.getString('channel_name');
        
        // Check if user has enough points
        getInvitePoints(user.id, guild.id, (err, data) => {
            if (err) {
                return interaction.reply({ content: '❌ Error checking your points.', ephemeral: true });
            }
            
            if (data.points < days) {
                const embed = createAdvancedEmbed('❌ Insufficient Points', 0xFF0000)
                    .addFields([
                        { name: '💎 Points Needed', value: `**${days}** points`, inline: true },
                        { name: '💰 Points Available', value: `**${data.points}** points`, inline: true },
                        { name: '📉 Missing', value: `**${days - data.points}** points`, inline: true }
                    ])
                    .setDescription('You need more invitation points to redeem this slot!\n\n💡 **Get more points by inviting friends:**\n🔗 Share your invite link and earn 1 point per new member!');
                
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            
            // Check if user already has a slot
            getSlot(user.id, guild.id, async (err, existingSlot) => {
                if (err) {
                    return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
                }
                
                if (existingSlot) {
                    return interaction.reply({ content: `❌ You already have an active slot. Remove it first with \`/removeslot\`.`, ephemeral: true });
                }
                
                await interaction.deferReply();
                
                // Subtract points first
                subtractInvitePoints(user.id, guild.id, days, async (err, success) => {
                    if (err || !success) {
                        return interaction.editReply({ content: '❌ Failed to deduct points. Please try again.' });
                    }
                    
                    // Create the free slot (same logic as /freeslot command)
                    getServerConfig(guild.id, async (err, config) => {
                        if (err) {
                            return interaction.editReply({ content: '❌ Failed to get server configuration.' });
                        }
                        
                        try {
                            // Find or create "FREE | slots" category
                            let slotsCategory = guild.channels.cache.find(channel => 
                                (channel.name.toLowerCase().includes('free') && channel.name.toLowerCase().includes('slots')) && channel.type === ChannelType.GuildCategory
                            );
                            
                            if (!slotsCategory) {
                                slotsCategory = await guild.channels.create({
                                    name: '🌟 FREE | slots',
                                    type: ChannelType.GuildCategory,
                                    reason: 'Creating free slots category for redeemed slot'
                                });
                            }
                            
                            // Create channel
                            const cleanChannelName = `⭐-${channelName.toLowerCase().replace(/[^a-z0-9\\-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')}`;
                            
                            const userChannel = await guild.channels.create({
                                name: cleanChannelName,
                                type: ChannelType.GuildText,
                                parent: slotsCategory.id,
                                reason: `Redeemed slot for ${user.tag}`,
                                permissionOverwrites: [
                                    {
                                        id: guild.roles.everyone,
                                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                                        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.UseExternalEmojis]
                                    },
                                    {
                                        id: user.id,
                                        allow: [
                                            PermissionFlagsBits.ViewChannel,
                                            PermissionFlagsBits.SendMessages,
                                            PermissionFlagsBits.ReadMessageHistory,
                                            PermissionFlagsBits.UseExternalEmojis,
                                            PermissionFlagsBits.AddReactions
                                        ]
                                    }
                                ]
                            });
                            
                            // Add slot to database
                            addSlot(user.id, user.tag, days, category, guild.id, userChannel.id, null, async (err) => {
                                if (err) {
                                    console.error('Database error when creating redeemed slot:', err);
                                    userChannel.delete().catch(console.error);
                                    return interaction.editReply({ content: `❌ Failed to create redeemed slot. Error: ${err.message}` });
                                }
                                
                                const embed = createAdvancedEmbed('🎉 Slot Redeemed Successfully!', 0x00FF00)
                                    .setDescription(`**${user.tag}** redeemed a free slot using invitation points!`)
                                    .addFields([
                                        { name: '👤 User', value: `${user}`, inline: true },
                                        { name: '⏰ Duration', value: formatDuration(days), inline: true },
                                        { name: '🏷️ Category', value: category, inline: true },
                                        { name: '💎 Points Used', value: `${days} points`, inline: true },
                                        { name: '💬 Channel', value: `${userChannel}`, inline: true },
                                        { name: '🔔 Limits', value: `@here: 1/day`, inline: true }
                                    ])
                                    .setThumbnail(user.displayAvatarURL({ dynamic: true }));
                                
                                const freeSlotImage = new AttachmentBuilder('./free_slots_image.png', { name: 'free_slots_image.png' });
                                interaction.editReply({ embeds: [embed], files: [freeSlotImage] });
                                
                                // Send welcome message to channel
                                const welcomeEmbed = createAdvancedEmbed(`🎉 Welcome to Your Redeemed Slot!`, 0x00FF00)
                                    .setDescription(`Hello ${user}! 👋\n\n**Your Redeemed Slot Benefits:**\n• Personal channel for ${formatDuration(days)}\n• 1 @here ping per day\n• Earned through invitations!\n\n**You're awesome for growing our community!** 🚀`)
                                    .setThumbnail(user.displayAvatarURL({ dynamic: true }));
                                
                                userChannel.send({ embeds: [welcomeEmbed] });
                                
                                // Log to logs channel
                                if (config.logs_channel_id) {
                                    const logsChannel = guild.channels.cache.get(config.logs_channel_id);
                                    if (logsChannel) {
                                        const logEmbed = createAdvancedEmbed('💎 Slot Redeemed', 0xFFD700)
                                            .addFields([
                                                { name: 'Action', value: 'Slot Redeemed with Points', inline: true },
                                                { name: 'User', value: `${user.tag}`, inline: true },
                                                { name: 'Points Used', value: `${days}`, inline: true },
                                                { name: 'Duration', value: formatDuration(days), inline: true },
                                                { name: 'Category', value: category, inline: true },
                                                { name: 'Channel', value: `${userChannel}`, inline: true }
                                            ]);
                                        logsChannel.send({ embeds: [logEmbed] });
                                    }
                                }
                            });
                        } catch (error) {
                            console.error('Error creating redeemed slot:', error);
                            return interaction.editReply({ content: '❌ Failed to create redeemed slot. Make sure the bot has proper permissions.' });
                        }
                    });
                });
            });
        });
    }
    
    else if (commandName === 'inviteleaderboard') {
        getTopInviters(guild.id, 10, (err, topInviters) => {
            if (err) {
                return interaction.reply({ content: '❌ Error retrieving leaderboard.', ephemeral: true });
            }
            
            if (topInviters.length === 0) {
                const embed = createAdvancedEmbed('📊 Invitation Leaderboard', 0x0099FF)
                    .setDescription('No invitations recorded yet! Be the first to invite friends and earn rewards! 🚀')
                    .addFields([
                        { name: '💡 How to Start', value: 'Invite friends to the server and earn 1 point per person!', inline: false },
                        { name: '🎁 Rewards', value: '1 Point = 1 Day of Free Slot', inline: false }
                    ]);
                return interaction.reply({ embeds: [embed] });
            }
            
            const leaderboard = topInviters.map((inviter, index) => {
                const user = guild.members.cache.get(inviter.user_id);
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                const userName = user ? user.displayName : 'Unknown User';
                return `${medal} ${userName} - **${inviter.total_invites}** invites (**${inviter.points}** points)`;
            }).join('\n');
            
            const embed = createAdvancedEmbed('🏆 Top Inviters Leaderboard', 0xFFD700)
                .setDescription(leaderboard)
                .addFields([
                    { name: '💡 Want to be here?', value: 'Invite friends and earn **1 point per invite**!', inline: false },
                    { name: '🎁 Redeem Points', value: 'Use `/redeemslot` to exchange points for free slots!', inline: false }
                ])
                .setThumbnail(guild.iconURL({ dynamic: true }));
            
            interaction.reply({ embeds: [embed] });
        });
    }
    
    else if (commandName === 'inviteinfo') {
        const embed = createAdvancedEmbed('🎉 Invitation Rewards System', 0x00AE86)
            .setDescription('**Grow our community and get rewarded!** 🚀\n\nEvery friend you invite earns you valuable points that can be exchanged for free slots!')
            .addFields([
                { name: '💎 How It Works', value: '• Invite friends to our server\n• Earn **1 point** per new member\n• Exchange points for free slots\n• **1 Point = 1 Day** of free slot!', inline: false },
                { name: '🎁 Rewards', value: '• **Free Slots**: Get your own channel\n• **@here permissions**: 1 per day\n• **Points tracking**: See your progress\n• **Leaderboard fame**: Compete with others!', inline: false },
                { name: '📈 Commands', value: '• `/invitepoints` - Check your points\n• `/redeemslot` - Exchange points for slots\n• `/inviteleaderboard` - See top inviters', inline: false },
                { name: '🔗 How to Invite', value: 'Create an invite link and share it with friends!\nUse Discord\'s invite feature or ask staff for help.', inline: false },
                { name: '🌟 Example', value: 'Invite **7 friends** = **7 points** = **7 days** of free slot!', inline: false }
            ])
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .setImage('https://media.giphy.com/media/3oz8xAeFcMrKQNGKVW/giphy.gif');
        
        interaction.reply({ embeds: [embed] });
    }
});

// Store invites when bot starts
let guildInvites = new Map();

// Member join event - full tracking with privileged intents
client.on('guildMemberAdd', async (member) => {
    console.log(`👋 New member joined: ${member.user.tag}`);
    
    try {
        const guild = member.guild;
        const user = member.user;
        
        // Get account age
        const accountAge = Date.now() - user.createdAt.getTime();
        const accountAgeDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
        const isOldAccount = accountAgeDays > 60; // More than 2 months
        
        // Try to find who invited this user
        let inviterInfo = null;
        try {
            const newInvites = await guild.invites.fetch();
            const oldInvites = guildInvites.get(guild.id) || new Map();
            
            const usedInvite = newInvites.find(invite => {
                const oldInvite = oldInvites.get(invite.code);
                return oldInvite && invite.uses > oldInvite.uses;
            });
            
            if (usedInvite && usedInvite.inviter) {
                inviterInfo = {
                    inviter: usedInvite.inviter,
                    code: usedInvite.code
                };
                
                // Add points to inviter
                addInvitePoints(usedInvite.inviter.id, guild.id, 1, (err) => {
                    if (err) console.error('Error adding invite points:', err);
                });
            }
            
            // Update stored invites
            const inviteMap = new Map();
            newInvites.forEach(invite => inviteMap.set(invite.code, invite));
            guildInvites.set(guild.id, inviteMap);
            
        } catch (error) {
            console.error('Error tracking invites:', error);
        }
        
        // Save welcome message
        saveWelcomeMessage(guild.id, user.id, user.tag);
        
        // Get server setup and config
        getServerSetup(guild.id, async (err, setup) => {
            if (err) {
                console.error('Error getting server setup:', err);
                return;
            }
            
            getServerConfig(guild.id, async (configErr, config) => {
                if (configErr) {
                    console.error('Error getting server config:', configErr);
                    return;
                }
                
                // Send welcome message to welcome channel
                if (setup && setup.welcome_channel_id) {
                    const welcomeChannel = guild.channels.cache.get(setup.welcome_channel_id);
                    if (welcomeChannel) {
                        const embed = createAdvancedEmbed('👋 Welcome!', 0x00FF00)
                            .setDescription(`Welcome ${user}, to **${guild.name}**! 🎉\n\nMake sure to read the rules and have fun!`)
                            .setThumbnail(user.displayAvatarURL({ dynamic: true }));
                        
                        welcomeChannel.send({ embeds: [embed] });
                    }
                }
                
                // Send detailed log to logs channel with member role management
                if (config && config.logs_channel_id) {
                    const logsChannel = guild.channels.cache.get(config.logs_channel_id);
                    if (logsChannel) {
                        const memberEmbed = createAdvancedEmbed('🆕 New Member Joined', 0x00FF00)
                            .setDescription(`${user} has joined the server!`)
                            .addFields([
                                { name: '👤 Username', value: user.tag, inline: true },
                                { name: '🆔 User ID', value: user.id, inline: true },
                                { name: '📅 Account Created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:F>`, inline: true },
                                { name: '⏰ Account Age', value: `${accountAgeDays} days`, inline: true },
                                { name: '🔗 Invited By', value: inviterInfo ? `${inviterInfo.inviter.tag} (${inviterInfo.inviter.id})` : 'Unknown/Vanity URL', inline: true },
                                { name: '📊 Total Members', value: guild.memberCount.toString(), inline: true }
                            ])
                            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
                            .setTimestamp();
                        
                        // Get member role
                        const memberRole = setup && setup.member_role_id ? guild.roles.cache.get(setup.member_role_id) : null;
                        
                        // Find the bot owner or admin who should be mentioned
                        const owner = await guild.fetchOwner().catch(() => null);
                        let mentionText = '';
                        if (owner) {
                            mentionText = `${owner.user}`;
                        }
                        
                        if (isOldAccount && memberRole) {
                            // Auto-assign member role for accounts older than 2 months
                            try {
                                await member.roles.add(memberRole, 'Account older than 2 months - auto role');
                                memberEmbed.addFields([
                                    { name: '✅ Member Role', value: `Auto-assigned ${memberRole.name} (account > 2 months)`, inline: false }
                                ]);
                                memberEmbed.setColor(0x00FF00);
                                
                                logsChannel.send({ 
                                    content: mentionText ? `${mentionText} - New member with auto role assigned` : undefined,
                                    embeds: [memberEmbed] 
                                });
                            } catch (error) {
                                console.error('Error auto-assigning member role:', error);
                                memberEmbed.addFields([
                                    { name: '❌ Auto Role Failed', value: `Could not assign ${memberRole.name} automatically`, inline: false }
                                ]);
                                logsChannel.send({ 
                                    content: mentionText ? `${mentionText} - New member needs manual role assignment` : undefined,
                                    embeds: [memberEmbed] 
                                });
                            }
                        } else if (memberRole) {
                            // Show button for manual role assignment for new accounts
                            memberEmbed.addFields([
                                { name: '⚠️ New Account', value: `Account is ${accountAgeDays} days old (< 2 months)\nRequires manual verification`, inline: false }
                            ]);
                            memberEmbed.setColor(0xFFA500); // Orange for new accounts
                            
                            const row = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`assign_member_role_${user.id}`)
                                        .setLabel(`Accept & Give ${memberRole.name}`)
                                        .setStyle(ButtonStyle.Success)
                                        .setEmoji('✅'),
                                    new ButtonBuilder()
                                        .setCustomId(`kick_member_${user.id}`)
                                        .setLabel('Reject & Kick')
                                        .setStyle(ButtonStyle.Danger)
                                        .setEmoji('👢')
                                );
                            
                            logsChannel.send({ 
                                content: mentionText ? `${mentionText} - NEW ACCOUNT NEEDS VERIFICATION (account < 2 months)` : undefined,
                                embeds: [memberEmbed],
                                components: [row]
                            });
                        } else {
                            // No member role configured
                            memberEmbed.addFields([
                                { name: '⚙️ No Member Role', value: 'No member role configured for this server', inline: false }
                            ]);
                            logsChannel.send({ 
                                content: mentionText ? `${mentionText} - New member joined` : undefined,
                                embeds: [memberEmbed] 
                            });
                        }
                    }
                }
            });
        });
        
    } catch (error) {
        console.error('Error handling member join:', error);
    }
});

// Button interaction handler for member role assignment
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    
    const { customId, guild, member: staffMember } = interaction;
    
    if (customId.startsWith('assign_member_role_') || customId.startsWith('kick_member_')) {
        const userId = customId.split('_').pop();
        const action = customId.startsWith('assign_') ? 'assign' : 'kick';
        
        try {
            const targetMember = await guild.members.fetch(userId).catch(() => null);
            if (!targetMember) {
                return interaction.reply({ 
                    content: '❌ Usuario no encontrado en el servidor.', 
                    ephemeral: true 
                });
            }
            
            getServerSetup(guild.id, async (err, setup) => {
                if (err || !setup || !setup.member_role_id) {
                    return interaction.reply({ 
                        content: '❌ No se ha configurado un rol de miembro para este servidor.', 
                        ephemeral: true 
                    });
                }
                
                const memberRole = guild.roles.cache.get(setup.member_role_id);
                if (!memberRole) {
                    return interaction.reply({ 
                        content: '❌ El rol de miembro configurado no existe.', 
                        ephemeral: true 
                    });
                }
                
                if (action === 'assign') {
                    try {
                        await targetMember.roles.add(memberRole, `Manual verification by ${staffMember.user.tag}`);
                        
                        // Update the embed to show the role was assigned
                        const originalEmbed = interaction.message.embeds[0];
                        const updatedEmbed = EmbedBuilder.from(originalEmbed)
                            .addFields([
                                { name: '✅ Role Assigned', value: `${memberRole.name} given by ${staffMember.user.tag}`, inline: false }
                            ])
                            .setColor(0x00FF00);
                        
                        await interaction.update({ 
                            embeds: [updatedEmbed], 
                            components: [] // Remove buttons
                        });
                        
                        // Log the action
                        logActivity(guild.id, targetMember.user.id, 'MEMBER_ROLE_ASSIGNED', `Manually assigned by ${staffMember.user.tag}`);
                        
                    } catch (error) {
                        console.error('Error assigning member role:', error);
                        return interaction.reply({ 
                            content: '❌ Error al asignar el rol. Verifica que el bot tenga permisos.', 
                            ephemeral: true 
                        });
                    }
                } else {
                    // Kick action
                    try {
                        // First update the embed
                        const originalEmbed = interaction.message.embeds[0];
                        const updatedEmbed = EmbedBuilder.from(originalEmbed)
                            .addFields([
                                { name: '👢 User Kicked', value: `Rejected and kicked by ${staffMember.user.tag}`, inline: false }
                            ])
                            .setColor(0xFF0000);
                        
                        await interaction.update({ 
                            embeds: [updatedEmbed], 
                            components: [] // Remove buttons
                        });
                        
                        // Log the action
                        logActivity(guild.id, targetMember.user.id, 'MEMBER_KICKED', `Kicked by ${staffMember.user.tag} - new account rejected`);
                        
                        // Now kick the user
                        await targetMember.kick(`New account rejected by ${staffMember.user.tag}`);
                        
                        // Send confirmation in logs channel
                        const kickConfirmEmbed = createAdvancedEmbed('👢 User Kicked', 0xFF0000)
                            .setDescription(`${targetMember.user.tag} has been kicked from the server`)
                            .addFields([
                                { name: '👤 User', value: `${targetMember.user.tag} (${targetMember.user.id})`, inline: true },
                                { name: '🛡️ Kicked By', value: staffMember.user.tag, inline: true },
                                { name: '📝 Reason', value: 'New account verification rejected', inline: false }
                            ])
                            .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }));
                        
                        const logsChannel = guild.channels.cache.get(interaction.message.channelId);
                        if (logsChannel) {
                            logsChannel.send({ embeds: [kickConfirmEmbed] });
                        }
                        
                    } catch (kickError) {
                        console.error('Error kicking member:', kickError);
                        
                        // Update embed to show kick failed
                        const originalEmbed = interaction.message.embeds[0];
                        const updatedEmbed = EmbedBuilder.from(originalEmbed)
                            .addFields([
                                { name: '❌ Kick Failed', value: `Could not kick user. Error: ${kickError.message}`, inline: false }
                            ])
                            .setColor(0xFF0000);
                        
                        await interaction.edit({ 
                            embeds: [updatedEmbed], 
                            components: [] 
                        });
                    }
                }
            });
            
        } catch (error) {
            console.error('Error in button interaction:', error);
            interaction.reply({ 
                content: '❌ Error al procesar la acción.', 
                ephemeral: true 
            });
        }
    }
});

// Track invite creation and deletion
client.on('inviteCreate', async (invite) => {
    try {
        const guildInviteMap = guildInvites.get(invite.guild.id) || new Map();
        guildInviteMap.set(invite.code, invite);
        guildInvites.set(invite.guild.id, guildInviteMap);
        console.log(`📋 New invite created: ${invite.code} by ${invite.inviter?.tag || 'Unknown'}`);
    } catch (error) {
        console.error('Error tracking invite creation:', error);
    }
});

client.on('inviteDelete', async (invite) => {
    try {
        const guildInviteMap = guildInvites.get(invite.guild.id);
        if (guildInviteMap) {
            guildInviteMap.delete(invite.code);
            console.log(`📋 Invite deleted: ${invite.code}`);
        }
    } catch (error) {
        console.error('Error tracking invite deletion:', error);
    }
});

// Automatic mention detection system (@here and @everyone)
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    
    const hasHere = message.content.includes('@here');
    const hasEveryone = message.content.includes('@everyone');
    
    if (!hasHere && !hasEveryone) return;
    
    console.log(`🔍 Mention detected from ${message.author.tag}: @here=${hasHere}, @everyone=${hasEveryone}`);
    
    // Check if user has an active slot
    getSlot(message.author.id, message.guild.id, async (err, slot) => {
        if (err || !slot) {
            console.log(`User ${message.author.tag} doesn't have a slot, ignoring`);
            return; // Only monitor users with slots
        }
        
        console.log(`✅ User ${message.author.tag} has a slot, tracking mention usage`);
        
        // Determine slot type
        const isVipSlot = slot.category.toLowerCase().includes('vip') || slot.category.toLowerCase().includes('💎');
        
        // Get server config
        getServerConfig(message.guild.id, async (configErr, config) => {
            if (configErr) return;
            
            if (!isVipSlot) {
                // FREE SLOTS: Only @here allowed, 1 per day
                if (hasEveryone) {
                    const warningEmbed = createAdvancedEmbed('🚫 @everyone Not Allowed', 0xFF0000)
                        .setDescription(`${message.author}, free slots cannot use @everyone!`)
                        .addFields([
                            { name: '✅ Allowed', value: `@here: ${config.max_here_per_day || 1}/day`, inline: true },
                            { name: '❌ Not Allowed', value: `@everyone`, inline: true }
                        ]);
                    message.channel.send({ embeds: [warningEmbed] });
                    return;
                }
                
                if (hasHere) {
                    incrementHereUsage(message.author.id, message.guild.id, (err) => {
                        if (err) {
                            console.error('Error incrementing @here usage:', err);
                            return;
                        }
                        
                        getHereUsage(message.author.id, message.guild.id, (err, usage) => {
                            if (err) return;
                            
                            const todayUsage = usage ? usage.count : 0;
                            const maxHere = config.max_here_per_day || 1;
                            const remaining = Math.max(0, maxHere - todayUsage);
                            
                            let notificationEmbed;
                            // Send simple counter message like in the image
                            let counterMessage;
                            if (todayUsage <= maxHere) {
                                counterMessage = `• **${todayUsage}/${maxHere}** @here | USE MM TO BE SURE`;
                                message.channel.send(counterMessage);
                            } else {
                                counterMessage = `• **${todayUsage}/${maxHere}** @here | ⚠️ LIMIT EXCEEDED`;
                                message.channel.send(counterMessage);
                                
                                // Add warning when limit exceeded
                                addWarning(message.author.id, message.guild.id, (err) => {
                                    if (err) {
                                        console.error('Error adding warning:', err);
                                        return;
                                    }
                                    
                                    // Check total warnings
                                    getWarnings(message.author.id, message.guild.id, async (err, warnings) => {
                                        if (err) return;
                                        
                                        const warningCount = warnings ? warnings.warning_count : 0;
                                        
                                        if (warningCount >= 2) {
                                            // Revoke slot after 2 warnings
                                            try {
                                                if (slot.channel_id) {
                                                    const channel = message.guild.channels.cache.get(slot.channel_id);
                                                    if (channel) {
                                                        await channel.delete(`Auto-revoked: ${message.author.tag} exceeded @here limit`);
                                                    }
                                                }
                                                
                                                if (slot.role_id) {
                                                    const targetMember = await message.guild.members.fetch(message.author.id).catch(() => null);
                                                    if (targetMember) {
                                                        const slotRole = message.guild.roles.cache.get(slot.role_id);
                                                        if (slotRole && targetMember.roles.cache.has(slotRole.id)) {
                                                            await targetMember.roles.remove(slotRole).catch(console.error);
                                                        }
                                                    }
                                                }
                                                
                                                removeSlot(message.author.id, message.guild.id, () => {});
                                                
                                                message.channel.send({
                                                    content: `🚫 ${message.author}, your **slot has been revoked** due to excessive @here usage after **${warningCount} warnings**.`
                                                });
                                            } catch (error) {
                                                console.error('Error revoking slot:', error);
                                            }
                                        } else {
                                            message.channel.send({
                                                content: `⚠️ Warning **${warningCount}/2** issued to ${message.author} for excessive @here usage. Next warning will result in **slot revocation**.`
                                            });
                                        }
                                    });
                                });
                            }
                        });
                    });
                }
            } else {
                // VIP SLOTS: @everyone (1/week) and @here (2/day)
                if (hasEveryone) {
                    incrementWeeklyMentions(message.author.id, message.guild.id, 'vip', 'everyone', (err) => {
                        if (err) return;
                        
                        getWeeklyMentionUsage(message.author.id, message.guild.id, 'vip', (err, weeklyUsage) => {
                            if (err) return;
                            
                            const everyoneUsed = weeklyUsage ? weeklyUsage.everyone_count : 0;
                            const maxEveryone = config.vip_everyone_per_week || 1;
                            const remaining = Math.max(0, maxEveryone - everyoneUsed);
                            
                            let notificationEmbed;
                            // Send simple counter message for @everyone
                            let counterMessage;
                            if (everyoneUsed <= maxEveryone) {
                                counterMessage = `• **${everyoneUsed}/${maxEveryone}** @everyone | USE MM TO BE SURE`;
                                message.channel.send(counterMessage);
                            } else {
                                counterMessage = `• **${everyoneUsed}/${maxEveryone}** @everyone | ⚠️ LIMIT EXCEEDED`;
                                message.channel.send(counterMessage);
                                
                                // Add warning when limit exceeded
                                addWarning(message.author.id, message.guild.id, (err) => {
                                    if (err) {
                                        console.error('Error adding warning:', err);
                                        return;
                                    }
                                    
                                    // Check total warnings
                                    getWarnings(message.author.id, message.guild.id, async (err, warnings) => {
                                        if (err) return;
                                        
                                        const warningCount = warnings ? warnings.warning_count : 0;
                                        
                                        if (warningCount >= 2) {
                                            // Revoke slot after 2 warnings
                                            try {
                                                if (slot.channel_id) {
                                                    const channel = message.guild.channels.cache.get(slot.channel_id);
                                                    if (channel) {
                                                        await channel.delete(`Auto-revoked: ${message.author.tag} exceeded @everyone limit`);
                                                    }
                                                }
                                                
                                                if (slot.role_id) {
                                                    const targetMember = await message.guild.members.fetch(message.author.id).catch(() => null);
                                                    if (targetMember) {
                                                        const slotRole = message.guild.roles.cache.get(slot.role_id);
                                                        if (slotRole && targetMember.roles.cache.has(slotRole.id)) {
                                                            await targetMember.roles.remove(slotRole).catch(console.error);
                                                        }
                                                    }
                                                }
                                                
                                                removeSlot(message.author.id, message.guild.id, () => {});
                                                
                                                message.channel.send({
                                                    content: `🚫 ${message.author}, your **slot has been revoked** due to excessive @everyone usage after **${warningCount} warnings**.`
                                                });
                                            } catch (error) {
                                                console.error('Error revoking slot:', error);
                                            }
                                        } else {
                                            message.channel.send({
                                                content: `⚠️ Warning **${warningCount}/2** issued to ${message.author} for excessive @everyone usage. Next warning will result in **slot revocation**.`
                                            });
                                        }
                                    });
                                });
                            }
                        });
                    });
                }
                
                if (hasHere) {
                    incrementHereUsage(message.author.id, message.guild.id, (err) => {
                        if (err) return;
                        
                        getHereUsage(message.author.id, message.guild.id, (err, usage) => {
                            if (err) return;
                            
                            const todayUsage = usage ? usage.count : 0;
                            const maxHere = config.vip_here_per_day || 2;
                            const remaining = Math.max(0, maxHere - todayUsage);
                            
                            let notificationEmbed;
                            // Send simple counter message for VIP @here
                            let counterMessage;
                            if (todayUsage <= maxHere) {
                                counterMessage = `• **${todayUsage}/${maxHere}** @here | USE MM TO BE SURE`;
                                message.channel.send(counterMessage);
                            } else {
                                counterMessage = `• **${todayUsage}/${maxHere}** @here | ⚠️ LIMIT EXCEEDED`;
                                message.channel.send(counterMessage);
                                
                                // Add warning when limit exceeded
                                addWarning(message.author.id, message.guild.id, (err) => {
                                    if (err) {
                                        console.error('Error adding warning:', err);
                                        return;
                                    }
                                    
                                    // Check total warnings
                                    getWarnings(message.author.id, message.guild.id, async (err, warnings) => {
                                        if (err) return;
                                        
                                        const warningCount = warnings ? warnings.warning_count : 0;
                                        
                                        if (warningCount >= 2) {
                                            // Revoke slot after 2 warnings
                                            try {
                                                if (slot.channel_id) {
                                                    const channel = message.guild.channels.cache.get(slot.channel_id);
                                                    if (channel) {
                                                        await channel.delete(`Auto-revoked: ${message.author.tag} exceeded @here limit`);
                                                    }
                                                }
                                                
                                                if (slot.role_id) {
                                                    const targetMember = await message.guild.members.fetch(message.author.id).catch(() => null);
                                                    if (targetMember) {
                                                        const slotRole = message.guild.roles.cache.get(slot.role_id);
                                                        if (slotRole && targetMember.roles.cache.has(slotRole.id)) {
                                                            await targetMember.roles.remove(slotRole).catch(console.error);
                                                        }
                                                    }
                                                }
                                                
                                                removeSlot(message.author.id, message.guild.id, () => {});
                                                
                                                message.channel.send({
                                                    content: `🚫 ${message.author}, your **slot has been revoked** due to excessive @here usage after **${warningCount} warnings**.`
                                                });
                                            } catch (error) {
                                                console.error('Error revoking slot:', error);
                                            }
                                        } else {
                                            message.channel.send({
                                                content: `⚠️ Warning **${warningCount}/2** issued to ${message.author} for excessive @here usage. Next warning will result in **slot revocation**.`
                                            });
                                        }
                                    });
                                });
                            }
                        });
                    });
                }
            }
        });
    });
});

// Schedule daily @here reset
cron.schedule('0 0 * * *', () => {
    console.log('🔄 Resetting daily @here usage counters...');
    db.run('DELETE FROM here_usage WHERE usage_date != ?', [getTodayString()]);
});

// Schedule weekly mention reset (every Monday at midnight)
cron.schedule('0 0 * * 1', () => {
    console.log('🔄 Resetting weekly mention usage counters...');
    db.run('DELETE FROM weekly_mention_usage WHERE week_start != ?', [getWeekStartString()]);
});

// Clean up expired slots
cron.schedule('0 0 * * *', () => {
    console.log('🧹 Cleaning up expired slots...');
    db.run('DELETE FROM slots WHERE expiry_date < ?', [Date.now()]);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down bot...');
    db.close((err) => {
        if (err) console.error('Error closing database:', err);
        else console.log('Database connection closed.');
        process.exit(0);
    });
});

// Start the bot
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ DISCORD_TOKEN environment variable is required!');
    process.exit(1);
}

client.login(token).catch(console.error);

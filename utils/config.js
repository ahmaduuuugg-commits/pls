require('dotenv').config();

const config = {
    // Server configuration
    PORT: process.env.PORT || 5000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // Haxball room configuration
    HAXBALL_TOKEN: process.env.HAXBALL_TOKEN || 'thr1.AAAAAGioii7He5G3opmqIQ.QWVGQjVKkXc',
    ROOM_NAME: process.env.ROOM_NAME || '🎮 RHL TOURNAMENT 🎮',
    MAX_PLAYERS: parseInt(process.env.MAX_PLAYERS) || 16,
    
    // Geographic settings
    GEO_CODE: process.env.GEO_CODE || 'eg',
    GEO_LAT: parseFloat(process.env.GEO_LAT) || 30.0444,
    GEO_LON: parseFloat(process.env.GEO_LON) || 31.2357,
    
    // Discord configuration
    DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || 'https://canary.discord.com/api/webhooks/1406959936851939379/Bla-hWfT8-lC5U9gXxouT9GA2W0Txltpnv4CrgzYvArO2mqMr_WaUkBA-TsYs3GrTXDT',
    DISCORD_INVITE: process.env.DISCORD_INVITE || 'https://discord.gg/R3Rtwqqhwm',
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '1406959666717790228',
    DISCORD_REPORT_ROLE_ID: process.env.DISCORD_REPORT_ROLE_ID || '1406593382632915014',
    
    // Authentication
    OWNER_PASSWORD: process.env.OWNER_PASSWORD || 'opopop',
    
    // Puppeteer configuration
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD !== 'false',
    
    // Monitoring configuration
    HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL) || 5000,
    RESTART_TIMEOUT: parseInt(process.env.RESTART_TIMEOUT) || 30000,
    KEEPALIVE_INTERVAL: parseInt(process.env.KEEPALIVE_INTERVAL) || 300000,
    
    // Logging
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    
    // Health check configuration
    HEALTH_CHECK_TIMEOUT: parseInt(process.env.HEALTH_CHECK_TIMEOUT) || 10000,
    MAX_RESTART_COUNT: parseInt(process.env.MAX_RESTART_COUNT) || 10,
    
    // Browser configuration
    BROWSER_ARGS: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ]
};

// Add Render-specific configurations
if (process.env.RENDER) {
    config.BROWSER_ARGS.push('--single-process');
    config.IS_RENDER = true;
} else {
    config.IS_RENDER = false;
}

// Validate required environment variables
const requiredVars = ['HAXBALL_TOKEN', 'DISCORD_WEBHOOK', 'OWNER_PASSWORD'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.warn('⚠️ Missing environment variables:', missingVars.join(', '));
    console.warn('⚠️ Using default values. Please set these variables for production use.');
}

// Export configuration
module.exports = config;

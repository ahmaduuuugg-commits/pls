const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const config = require('./utils/config');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Global variables
let browser = null;
let page = null;
let roomStatus = {
    isActive: false,
    lastHeartbeat: null,
    playersCount: 0,
    roomName: '',
    startTime: null,
    restartCount: 0
};

// Health check endpoint
app.get('/health', (req, res) => {
    const status = {
        server: 'running',
        room: roomStatus.isActive ? 'active' : 'inactive',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        lastHeartbeat: roomStatus.lastHeartbeat,
        playersCount: roomStatus.playersCount,
        restartCount: roomStatus.restartCount
    };
    
    res.json(status);
});

// Status endpoint for monitoring
app.get('/status', (req, res) => {
    res.json(roomStatus);
});

// Manual restart endpoint
app.post('/restart', async (req, res) => {
    logger.info('Manual restart requested');
    try {
        await restartRoom();
        res.json({ success: true, message: 'Room restart initiated' });
    } catch (error) {
        logger.error('Manual restart failed:', error);
        res.status(500).json({ success: false, message: 'Restart failed' });
    }
});

// Initialize Puppeteer browser
async function initBrowser() {
    try {
        logger.info('Initializing Puppeteer browser...');
        
        const browserArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            // WebRTC support
            '--enable-webrtc',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-running-insecure-content',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--ignore-certificate-errors',
            '--ignore-ssl-errors',
            '--ignore-certificate-errors-spki-list',
            '--ignore-certificate-errors-ssl-errors',
            // Additional network settings
            '--disable-background-networking',
            '--enable-features=NetworkService,NetworkServiceLogging',
            '--disable-ipc-flooding-protection',
            '--force-webrtc-ip-handling-policy=default'
        ];

        // Additional args for Render environment
        if (process.env.RENDER) {
            browserArgs.push('--single-process');
        }

        // Use system chromium
        const executablePath = config.PUPPETEER_EXECUTABLE_PATH;

        browser = await puppeteer.launch({
            headless: 'new',
            args: browserArgs,
            defaultViewport: { width: 1280, height: 720 },
            executablePath: executablePath
        });

        logger.info('Browser initialized successfully');
        return browser;
    } catch (error) {
        logger.error('Failed to initialize browser:', error);
        throw error;
    }
}

// Geographic fallback locations
const GEO_LOCATIONS = [
    { code: 'tr', lat: 41.0082, lon: 28.9784, name: 'Turkey - Istanbul' },
    { code: 'de', lat: 52.5200, lon: 13.4050, name: 'Germany - Berlin' }, 
    { code: 'nl', lat: 52.3676, lon: 4.9041, name: 'Netherlands - Amsterdam' },
    { code: 'eg', lat: 30.0444, lon: 31.2357, name: 'Egypt - Cairo' },
    { code: 'ae', lat: 25.2048, lon: 55.2708, name: 'UAE - Dubai' }
];

// Create new page and setup Haxball room with location fallback
async function createHaxballRoom(locationIndex = 0) {
    try {
        logger.info('Creating new Haxball room...');
        
        if (!browser) {
            await initBrowser();
        }

        page = await browser.newPage();
        
        // Enable WebRTC permissions
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://www.haxball.com', [
            'camera',
            'microphone',
            'notifications',
            'geolocation'
        ]);
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to Haxball
        await page.goto('https://www.haxball.com/headless', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        logger.info('Navigated to Haxball headless page');

        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Test WebRTC before creating room
        const webrtcSupported = await page.evaluate(() => {
            return new Promise((resolve) => {
                if (!window.RTCPeerConnection) {
                    resolve(false);
                    return;
                }
                
                const pc = new RTCPeerConnection({
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' }
                    ]
                });
                
                let candidatesFound = false;
                const timeout = setTimeout(() => {
                    pc.close();
                    resolve(candidatesFound);
                }, 10000);
                
                pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        candidatesFound = true;
                        clearTimeout(timeout);
                        pc.close();
                        resolve(true);
                    }
                };
                
                pc.createDataChannel('test');
                pc.createOffer().then(offer => {
                    return pc.setLocalDescription(offer);
                }).catch(() => {
                    clearTimeout(timeout);
                    pc.close();
                    resolve(false);
                });
            });
        });
        
        if (!webrtcSupported) {
            throw new Error('WebRTC is not supported or blocked in this environment');
        }
        
        logger.info('WebRTC test passed - connection candidates found');
        
        // Test Haxball API accessibility
        try {
            const haxballTest = await page.evaluate(() => {
                return fetch('https://www.haxball.com/headlesstoken', { method: 'GET' })
                    .then(response => response.status)
                    .catch(err => 'network_error');
            });
            logger.info(`Haxball API test result: ${haxballTest}`);
        } catch (error) {
            logger.warn('Could not test Haxball API accessibility:', error.message);
        }

        // Load tournament script
        const tournamentScript = fs.readFileSync(path.join(__dirname, 'scripts/haxball-tournament.js'), 'utf8');
        
        // Replace all process.env references with actual values
        let configuredScript = tournamentScript;
        
        // Log before replacements
        logger.info('Configuring tournament script with environment variables');
        
        // Use current location or fallback
        const currentLocation = GEO_LOCATIONS[locationIndex] || GEO_LOCATIONS[0];
        logger.info(`Attempting room creation with location: ${currentLocation.name}`);
        
        // Replace process.env references systematically
        const replacements = [
            { pattern: /process\.env\.ROOM_NAME/g, value: `"${config.ROOM_NAME}"` },
            { pattern: /parseInt\(process\.env\.MAX_PLAYERS\)/g, value: config.MAX_PLAYERS },
            { pattern: /process\.env\.MAX_PLAYERS/g, value: config.MAX_PLAYERS },
            { pattern: /process\.env\.GEO_CODE/g, value: `"${currentLocation.code}"` },
            { pattern: /parseFloat\(process\.env\.GEO_LAT\)/g, value: currentLocation.lat },
            { pattern: /process\.env\.GEO_LAT/g, value: currentLocation.lat },
            { pattern: /parseFloat\(process\.env\.GEO_LON\)/g, value: currentLocation.lon },
            { pattern: /process\.env\.GEO_LON/g, value: currentLocation.lon },
            { pattern: /process\.env\.HAXBALL_TOKEN/g, value: `"${config.HAXBALL_TOKEN}"` },
            { pattern: /process\.env\.DISCORD_WEBHOOK/g, value: `"${config.DISCORD_WEBHOOK}"` },
            { pattern: /process\.env\.DISCORD_CHANNEL_ID/g, value: `"${config.DISCORD_CHANNEL_ID}"` },
            { pattern: /process\.env\.DISCORD_REPORT_ROLE_ID/g, value: `"${config.DISCORD_REPORT_ROLE_ID}"` },
            { pattern: /process\.env\.DISCORD_INVITE/g, value: `"${config.DISCORD_INVITE}"` },
            { pattern: /process\.env\.OWNER_PASSWORD/g, value: `"${config.OWNER_PASSWORD}"` }
        ];
        
        replacements.forEach(({ pattern, value }) => {
            const matches = configuredScript.match(pattern);
            if (matches) {
                logger.info(`Replacing ${matches.length} instances of ${pattern.source}`);
                configuredScript = configuredScript.replace(pattern, value);
            }
        });
        
        // Final check for any remaining process.env references
        const remainingProcessEnv = configuredScript.match(/process\.env/g);
        if (remainingProcessEnv) {
            logger.warn(`Found ${remainingProcessEnv.length} remaining process.env references`);
            // Replace any remaining process.env with empty object to prevent errors
            configuredScript = configuredScript.replace(/process\.env/g, '{}');
        }

        // Add console event listeners
        page.on('console', (msg) => {
            const type = msg.type();
            const text = msg.text();
            if (type === 'error') {
                logger.error(`Browser Console ERROR: ${text}`);
            } else if (type === 'log') {
                logger.info(`Browser Console LOG: ${text}`);
            } else if (type === 'warn') {
                logger.warn(`Browser Console WARN: ${text}`);
            }
        });
        
        page.on('pageerror', (error) => {
            logger.error('Page Error:', error.message);
        });
        
        // Add error capturing before script injection
        await page.evaluateOnNewDocument(() => {
            window.initErrors = [];
            window.console.logs = [];
        });
        
        // Inject tournament script and capture room link
        const roomResult = await page.evaluate(configuredScript);
        
        logger.info('Tournament script injected successfully');
        
        // Wait for room creation with better debugging
        logger.info('Waiting for room initialization...');
        
        const roomInitialized = await page.waitForFunction(() => {
            // Add debugging information to window
            window.debugInfo = {
                roomExists: typeof window.room !== 'undefined',
                roomType: typeof window.room,
                hasGetPlayerList: window.room && typeof window.room.getPlayerList === 'function',
                roomObject: window.room ? 'room object exists' : 'no room object',
                errors: window.initErrors || [],
                hbInitCalled: window.hbInitCalled || false
            };
            
            return window.room && typeof window.room.getPlayerList === 'function';
        }, { timeout: 20000 }).catch(async () => {
            // Get debug info if timeout occurs
            const debugInfo = await page.evaluate(() => window.debugInfo || {});
            logger.error('Room initialization timeout. Debug info:', debugInfo);
            
            // Try to get any console errors
            const consoleErrors = await page.evaluate(() => {
                return window.console.logs || [];
            });
            if (consoleErrors.length > 0) {
                logger.error('Console errors:', consoleErrors);
            }
            
            return false;
        });
        
        // Only proceed if room was initialized
        if (!roomInitialized) {
            throw new Error('Room initialization failed - timeout exceeded');
        }
        
        // Get room link
        const roomLink = await page.evaluate(() => {
            try {
                return window.location.href || 'No room link available';
            } catch (error) {
                return 'Error getting room link: ' + error.message;
            }
        });
        
        logger.info('Room link:', roomLink);
        
        // Test if room is actually accessible
        const roomTest = await page.evaluate(() => {
            try {
                if (window.room && window.room.getPlayerList) {
                    const players = window.room.getPlayerList();
                    return {
                        playersCount: players.length,
                        roomName: window.room.name || 'Unknown',
                        success: true
                    };
                }
                return { success: false, error: 'Room not initialized' };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });
        
        logger.info('Room test result:', roomTest);

        // Setup heartbeat monitoring
        await setupHeartbeatMonitoring();
        
        // Setup room status monitoring
        await setupRoomMonitoring();
        
        roomStatus.isActive = true;
        roomStatus.startTime = new Date();
        roomStatus.lastHeartbeat = new Date();
        
        logger.info('Haxball room created and monitoring started');
        
    } catch (error) {
        logger.error(`Failed to create Haxball room with ${GEO_LOCATIONS[locationIndex]?.name || 'default location'}:`, error);
        
        // Try next location if available
        if (locationIndex < GEO_LOCATIONS.length - 1) {
            logger.info(`Trying next location (${locationIndex + 1}/${GEO_LOCATIONS.length})...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return createHaxballRoom(locationIndex + 1);
        }
        
        throw error;
    }
}

// Setup heartbeat monitoring
async function setupHeartbeatMonitoring() {
    try {
        // Inject heartbeat script into the page
        await page.evaluate(() => {
            // Setup heartbeat system
            window.haxballHeartbeat = {
                lastBeat: Date.now(),
                interval: null,
                start: function() {
                    this.interval = setInterval(() => {
                        this.lastBeat = Date.now();
                        // Store heartbeat data in window for external access
                        window.roomHeartbeat = {
                            timestamp: this.lastBeat,
                            playersCount: room ? room.getPlayerList().length : 0,
                            roomName: room ? 'RHL TOURNAMENT' : 'Unknown'
                        };
                    }, 5000);
                }
            };
            
            // Start heartbeat when room is initialized
            if (typeof room !== 'undefined') {
                window.haxballHeartbeat.start();
            } else {
                // Wait for room to be initialized
                const checkRoom = setInterval(() => {
                    if (typeof room !== 'undefined') {
                        window.haxballHeartbeat.start();
                        clearInterval(checkRoom);
                    }
                }, 1000);
            }
        });
        
        logger.info('Heartbeat monitoring setup complete');
    } catch (error) {
        logger.error('Failed to setup heartbeat monitoring:', error);
    }
}

// Setup room monitoring
async function setupRoomMonitoring() {
    setInterval(async () => {
        try {
            if (page && !page.isClosed()) {
                const heartbeatData = await page.evaluate(() => {
                    return window.roomHeartbeat || null;
                });
                
                if (heartbeatData) {
                    roomStatus.lastHeartbeat = new Date(heartbeatData.timestamp);
                    roomStatus.playersCount = heartbeatData.playersCount;
                    roomStatus.roomName = heartbeatData.roomName;
                }
                
                // Check if heartbeat is too old (more than 30 seconds)
                const now = new Date();
                if (roomStatus.lastHeartbeat && (now - roomStatus.lastHeartbeat) > 30000) {
                    logger.warn('Heartbeat is stale, restarting room...');
                    await restartRoom();
                }
            }
        } catch (error) {
            logger.error('Room monitoring error:', error);
            await restartRoom();
        }
    }, 10000); // Check every 10 seconds
}

// Restart room function
async function restartRoom() {
    try {
        logger.info('Restarting Haxball room...');
        roomStatus.isActive = false;
        roomStatus.restartCount++;
        
        if (page && !page.isClosed()) {
            await page.close();
        }
        
        if (browser) {
            await browser.close();
            browser = null;
        }
        
        // Wait before restart
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        await createHaxballRoom();
        logger.info('Room restart completed');
        
    } catch (error) {
        logger.error('Failed to restart room:', error);
        // Wait longer before retry
        setTimeout(() => restartRoom(), 30000);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    roomStatus.isActive = false;
    
    if (page && !page.isClosed()) {
        await page.close();
    }
    
    if (browser) {
        await browser.close();
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    roomStatus.isActive = false;
    
    if (page && !page.isClosed()) {
        await page.close();
    }
    
    if (browser) {
        await browser.close();
    }
    
    process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info('Initializing Haxball room...');
    
    try {
        await createHaxballRoom();
        logger.info('Haxball room initialization complete');
    } catch (error) {
        logger.error('Failed to initialize Haxball room:', error);
        // Retry after 30 seconds
        setTimeout(async () => {
            try {
                await createHaxballRoom();
            } catch (retryError) {
                logger.error('Retry failed:', retryError);
            }
        }, 30000);
    }
});

// Keepalive ping every 5 minutes
setInterval(() => {
    logger.info('Keepalive ping - Room status:', roomStatus.isActive ? 'Active' : 'Inactive');
}, 300000);

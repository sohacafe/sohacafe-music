require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const musicPlayer = require('./music-player');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// YouTube API
const YOUTUBE_API_KEY = 'AIzaSyC-z8ZrVVJZUUIlqws2ltZfSlzjD9OnGuQ';
const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';

// MEKAN AYARLARI
const venueSettings = {
    isActive: true,
    wifiSSID: "Mekan_WiFi",
    allowedIPRange: ["192.168.1", "10.0.0", "172.16.0"],
    checkWiFi: true,
    checkIP: true
};

const sessions = new Map();
const QR_EXPIRY_TIME = 365 * 24 * 60 * 60 * 1000;

let queue = [];
let currentTrack = null;
let isPlaying = false;

// Rate Limiting
const userRequests = new Map();
const RATE_LIMIT = {
  search: { windowMs: 60000, max: 15 },
  queue: { windowMs: 30000, max: 5 }
};

function getClientIP(req) {
    return req.ip || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

function checkVenueAccess(req) {
    if (!venueSettings.isActive) return true;
    
    const clientIP = getClientIP(req);
    console.log('📍 Erişim kontrolü - IP:', clientIP);
    
    if (venueSettings.checkIP) {
        const isInVenue = venueSettings.allowedIPRange.some(ip => clientIP.startsWith(ip));
        if (!isInVenue) {
            console.log('🚫 Erişim reddedildi - IP uyumsuz:', clientIP);
            return false;
        }
    }
    
    return true;
}

function checkRateLimit(userId, type) {
  const now = Date.now();
  const limit = RATE_LIMIT[type];
  
  if (!userRequests.has(userId)) {
    userRequests.set(userId, {});
  }
  
  const userData = userRequests.get(userId);
  
  if (!userData[type]) {
    userData[type] = { count: 1, firstRequest: now };
    return true;
  }
  
  const timeDiff = now - userData[type].firstRequest;
  
  if (timeDiff > limit.windowMs) {
    userData[type] = { count: 1, firstRequest: now };
    return true;
  }
  
  if (userData[type].count >= limit.max) {
    return false;
  }
  
  userData[type].count++;
  return true;
}

function isValidYouTubeUrl(url) {
  const patterns = [
    /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=)[a-zA-Z0-9_-]{11}/,
    /^(https?:\/\/)?(youtu\.be\/)[a-zA-Z0-9_-]{11}/,
    /^(https?:\/\/)?(www\.)?(youtube\.com\/embed\/)[a-zA-Z0-9_-]{11}/
  ];
  
  return patterns.some(pattern => pattern.test(url));
}

async function playNextTrack() {
  if (queue.length > 0 && !isPlaying) {
    isPlaying = true;
    currentTrack = queue[0];
    
    console.log('🎵 Çalınıyor:', currentTrack.track.title);
    
    io.emit('trackChanged', { currentTrack, queue });
    io.emit('playerState', { isPlaying, currentTrack });
    io.emit('queueUpdate', { queue, currentTrack, isPlaying });

    try {
      await musicPlayer.playYouTubeMusic(currentTrack.track.url);
      
      console.log('✅ Şarkı bitti:', currentTrack.track.title);
      
      queue.shift();
      currentTrack = null;
      isPlaying = false;
      
      playNextTrack();
      
    } catch (error) {
      console.error('❌ Şarkı çalma hatası:', error);
      isPlaying = false;
      currentTrack = null;
      if (queue.length > 0) {
        playNextTrack();
      }
    }
    
  } else if (queue.length === 0) {
    currentTrack = null;
    isPlaying = false;
    console.log('⏹️ Kuyruk boş, müzik durdu');
    io.emit('queueUpdate', { queue, currentTrack, isPlaying });
  }
}

function createSession() {
  const sessionId = uuidv4();
  const expiryTime = Date.now() + QR_EXPIRY_TIME;
  
  const session = {
    id: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(expiryTime),
    isValid: true,
    userCount: 0,
    isPermanent: true
  };
  
  sessions.set(sessionId, session);
  console.log('✅ SABİT QR oluşturuldu:', sessionId);
  
  return session;
}

function requireValidSession(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  
  if (!sessionId) {
    return res.status(403).json({ 
      success: false,
      error: 'Mekan oturumu gerekiyor. Lütfen QR kodu okutun.' 
    });
  }
  
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(403).json({ 
      success: false,
      error: 'Geçersiz oturum. Lütfen yeni QR kodu okutun.' 
    });
  }
  
  if (!session.isValid) {
    return res.status(403).json({ 
      success: false,
      error: 'Oturum geçersiz. Lütfen yeni QR kodu okutun.' 
    });
  }
  
  if (Date.now() > session.expiresAt) {
    session.isValid = false;
    return res.status(403).json({ 
      success: false,
      error: 'Oturum süresi dolmuş. Lütfen yeni QR kodu okutun.' 
    });
  }
  
  req.session = session;
  next();
}

async function searchYouTubeMusic(query) {
  try {
    console.log('🎵 YouTube API arama:', query);
    
    const response = await axios.get(`${YOUTUBE_API_URL}/search`, {
      params: {
        part: 'snippet',
        q: query + ' official music',
        type: 'video',
        videoCategoryId: '10',
        maxResults: 5,
        key: YOUTUBE_API_KEY
      }
    });

    console.log('✅ YouTube API başarılı! Sonuç:', response.data.items.length);
    
    const videos = response.data.items;
    
    if (!videos || videos.length === 0) {
      return getMockResults(query);
    }

    const results = videos.map(video => ({
      id: video.id.videoId,
      title: video.snippet.title,
      artist: video.snippet.channelTitle,
      duration: '3:00',
      thumbnail: video.snippet.thumbnails.medium.url,
      source: 'youtube',
      url: `https://www.youtube.com/watch?v=${video.id.videoId}`
    }));

    return results;

  } catch (error) {
    console.error('❌ YouTube API hatası:', error.response?.data || error.message);
    return getMockResults(query);
  }
}

function getMockResults(query) {
  return [
    {
      id: 'mock_1',
      title: 'Shape of You - ' + query,
      artist: 'Ed Sheeran',
      duration: '3:45',
      thumbnail: 'https://via.placeholder.com/120x90/007bff/ffffff?text=🎵',
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=JGwWNGJdvx8'
    },
    {
      id: 'mock_2', 
      title: 'Blinding Lights - ' + query,
      artist: 'The Weeknd',
      duration: '3:20',
      thumbnail: 'https://via.placeholder.com/120x90/28a745/ffffff?text=🎶',
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=4NRXx6U8ABQ'
    }
  ];
}

// ADMIN ENDPOINTS
app.get('/api/admin/settings', (req, res) => {
    res.json({ success: true, settings: venueSettings });
});

app.post('/api/admin/settings', (req, res) => {
    const { isActive, wifiSSID, checkWiFi, checkIP } = req.body;
    
    venueSettings.isActive = isActive !== undefined ? isActive : venueSettings.isActive;
    venueSettings.wifiSSID = wifiSSID || venueSettings.wifiSSID;
    venueSettings.checkWiFi = checkWiFi !== undefined ? checkWiFi : venueSettings.checkWiFi;
    venueSettings.checkIP = checkIP !== undefined ? checkIP : venueSettings.checkIP;
    
    console.log('🔧 Admin ayarları güncellendi:', venueSettings);
    res.json({ success: true, settings: venueSettings });
});

app.get('/api/admin/statistics', (req, res) => {
    const activeSessions = Array.from(sessions.values()).filter(s => s.isValid).length;
    const totalUsers = Array.from(sessions.values()).filter(s => s.isValid).reduce((sum, s) => sum + s.userCount, 0);
    
    res.json({
        success: true,
        statistics: {
            activeSessions,
            totalUsers,
            queueLength: queue.length,
            isPlaying: isPlaying,
            venueStatus: venueSettings.isActive ? '🟢 Aktif' : '🔴 Kapalı'
        }
    });
});

app.post('/api/admin/reset-sessions', (req, res) => {
    sessions.clear();
    queue.length = 0;
    currentTrack = null;
    isPlaying = false;
    
    console.log('🔄 Tüm oturumlar temizlendi');
    res.json({ success: true, message: 'Tüm oturumlar temizlendi' });
});

// QR KOD API
app.get('/api/qr/generate', async (req, res) => {
  try {
    const session = createSession();
    const qrData = {
      sessionId: session.id,
      action: 'join-venue',
      timestamp: Date.now(),
      baseUrl: `https://sohacafe.onrender.com`
    };
    
    const qrCodeUrl = await QRCode.toDataURL(JSON.stringify(qrData));
    
    res.json({
      success: true,
      session: {
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        isValid: session.isValid
      },
      qrCode: qrCodeUrl,
      directUrl: `https://sohacafe.onrender.com/join/${session.id}`,
      expiryTime: session.expiresAt
    });
  } catch (error) {
    console.error('QR kod hatası:', error);
    res.status(500).json({ 
      success: false, 
      error: 'QR kod oluşturulamadı' 
    });
  }
});

app.get('/join/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session || !session.isValid) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Geçersiz QR Kod</title></head>
      <body>
        <h2>❌ Geçersiz QR Kod</h2>
        <p>Lütfen yeni QR kod alın.</p>
      </body>
      </html>
    `);
  }
  
  session.userCount += 1;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Hoş Geldiniz</title></head>
    <body>
      <h2>✅ Hoş Geldiniz!</h2>
      <p>Yönlendiriliyorsunuz...</p>
      <script>
        localStorage.setItem('musicQueueSession', '${sessionId}');
        setTimeout(() => {
          window.location.href = '/?sessionId=${sessionId}';
        }, 2000);
      </script>
    </body>
    </html>
  `);
});

app.get('/api/session/check', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  
  if (!sessionId) {
    return res.json({ isValid: false, reason: 'Oturum bulunamadı' });
  }
  
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ isValid: false, reason: 'Geçersiz oturum' });
  }
  
  if (!session.isValid) {
    return res.json({ isValid: false, reason: 'Oturum geçersiz' });
  }
  
  if (Date.now() > session.expiresAt) {
    session.isValid = false;
    return res.json({ isValid: false, reason: 'Oturum süresi dolmuş' });
  }
  
  res.json({ 
    isValid: true, 
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      userCount: session.userCount
    }
  });
});

// API ROUTES
app.get('/api/status', requireValidSession, (req, res) => {
  res.json({ 
    success: true,
    queue, 
    currentTrack, 
    isPlaying,
    totalQueue: queue.length,
    totalUsers: Array.from(sessions.values()).filter(s => s.isValid).reduce((sum, s) => sum + s.userCount, 0)
  });
});

app.post('/api/search', requireValidSession, async (req, res) => {
  if (!checkVenueAccess(req)) {
    return res.status(403).json({ 
      success: false,
      error: '🚫 Sadece mekan içinden erişebilirsiniz. Lütfen mekan WiFi\'sına bağlanın.' 
    });
  }

  const { query, source = 'youtube' } = req.body;
  
  if (!query) {
    return res.status(400).json({ 
      success: false,
      error: 'Arama sorgusu gerekli' 
    });
  }

  if (!checkRateLimit(req.session.id, 'search')) {
    return res.status(429).json({ 
      success: false,
      error: 'Çok fazla arama yaptınız. Lütfen 1 dakika bekleyin.' 
    });
  }

  try {
    let results = [];
    
    if (source === 'youtube') {
      results = await searchYouTubeMusic(query);
    }
    
    res.json({ 
      success: true, 
      results
    });
  } catch (error) {
    console.error('Arama hatası:', error);
    res.json({ 
      success: true, 
      results: []
    });
  }
});

app.post('/api/queue', requireValidSession, async (req, res) => {
  if (!checkVenueAccess(req)) {
    return res.status(403).json({ 
      success: false,
      error: '🚫 Sadece mekan içinden erişebilirsiniz. Lütfen mekan WiFi\'sına bağlanın.' 
    });
  }

  const { track, user = 'Anonim Kullanıcı', source = 'youtube' } = req.body;
  
  if (!track || !track.title) {
    return res.status(400).json({ 
      success: false,
      error: 'Geçersiz parça verisi' 
    });
  }

  if (!isValidYouTubeUrl(track.url)) {
    return res.status(400).json({ 
      success: false,
      error: 'Geçersiz YouTube URL. Lütfen geçerli bir YouTube linki girin.' 
    });
  }

  if (!checkRateLimit(req.session.id, 'queue')) {
    return res.status(429).json({ 
      success: false,
      error: 'Çok hızlı şarkı ekliyorsunuz. Lütfen 30 saniye bekleyin.' 
    });
  }

  const newTrack = {
    id: `${source}_${track.id || Date.now()}`,
    track: {
      ...track,
      source: source
    },
    user: user,
    addedAt: new Date(),
    status: 'waiting',
    sessionId: req.session.id
  };

  queue.push(newTrack);
  
  if (queue.length === 1 && !isPlaying) {
    console.log('🎵 İlk şarkı, otomatik başlatılıyor...');
    playNextTrack();
  }
  
  io.emit('queueUpdate', { 
    queue, 
    currentTrack, 
    isPlaying,
    totalUsers: Array.from(sessions.values()).filter(s => s.isValid).reduce((sum, s) => sum + s.userCount, 0)
  });
  
  res.json({ 
    success: true, 
    track: newTrack,
    position: queue.length
  });
});

// PLAYER CONTROL
app.post('/api/player/play', async (req, res) => {
  if (currentTrack && !isPlaying) {
    playNextTrack();
    res.json({ success: true, state: 'playing' });
  } else {
    res.json({ 
      success: false, 
      message: 'Çalınacak parça yok veya zaten çalınıyor' 
    });
  }
});

app.post('/api/player/pause', (req, res) => {
  isPlaying = false;
  musicPlayer.stop();
  io.emit('playerState', { isPlaying, currentTrack });
  io.emit('queueUpdate', { queue, currentTrack, isPlaying });
  res.json({ success: true, state: 'paused' });
});

app.post('/api/player/next', (req, res) => {
  musicPlayer.stop();
  res.json({ success: true });
});

app.post('/api/player/stop', (req, res) => {
  isPlaying = false;
  musicPlayer.stop();
  currentTrack = null;
  queue = [];
  io.emit('playerState', { isPlaying, currentTrack });
  io.emit('queueUpdate', { queue, currentTrack, isPlaying });
  res.json({ success: true, state: 'stopped' });
});

// HTML ROUTES
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/player.html'));
});

app.get('/admin/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/qr-admin.html'));
});

// SOCKET.IO
io.on('connection', (socket) => {
  console.log('✅ Yeni istemci bağlandı:', socket.id);
  
  socket.emit('queueUpdate', { 
    queue, 
    currentTrack, 
    isPlaying,
    totalUsers: Array.from(sessions.values()).filter(s => s.isValid).reduce((sum, s) => sum + s.userCount, 0)
  });
  
  socket.on('disconnect', () => {
    console.log('❌ İstemci ayrıldı:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 SOHACAFE MÜZİK SİSTEMİ RENDER'DA ÇALIŞIYOR!`);
  console.log(`📱 URL: https://sohacafe.onrender.com`);
});


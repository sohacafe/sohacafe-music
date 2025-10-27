const { spawn } = require('child_process');
const fs = require('fs');

class MusicPlayer {
    constructor() {
        this.currentProcess = null;
        this.isPlaying = false;
        this.currentVolume = 100; // Varsayılan ses seviyesi
        this.currentUrl = null;
    }

    async playYouTubeMusic(youtubeUrl) {
        console.log('🎵 Müzik başlatılıyor...');
        console.log('📺 YouTube URL:', youtubeUrl);

        // Önceki müziği durdur
        this.stop();

        return new Promise((resolve, reject) => {
            try {
                // 1. ADIM: yt-dlp ile ses URL'sini al
                this.getAudioUrl(youtubeUrl).then(audioUrl => {
                    console.log('✅ Ses URLsi alındı');

                    // 2. ADIM: VLC path'ini bul
                    const vlcPath = this.findVLCPath();
                    if (!vlcPath) {
                        reject(new Error('VLC bulunamadı!'));
                        return;
                    }

                    console.log('✅ VLC bulundu:', vlcPath);

                    // 3. ADIM: VLC'yi ses URL'si ile başlat (ses seviyesi ile)
                    this.currentUrl = audioUrl;
                    const fullCommand = `"${vlcPath}" "${audioUrl}" --play-and-exit --no-video --quiet --gain=${this.currentVolume}`;
                    console.log('🔨 Komut:', fullCommand);

                    this.currentProcess = spawn(fullCommand, [], {
                        shell: true,
                        stdio: 'ignore'
                    });

                    this.isPlaying = true;

                    // VLC kapandığında (müzik bittiğinde)
                    this.currentProcess.on('close', (code) => {
                        console.log('🎵 Müzik bitti. Çıkış kodu:', code);
                        this.currentProcess = null;
                        this.isPlaying = false;
                        this.currentUrl = null;
                        resolve(); // Müzik bitti, promise'i çöz
                    });

                    this.currentProcess.on('error', (error) => {
                        console.error('❌ VLC hatası:', error);
                        this.currentProcess = null;
                        this.isPlaying = false;
                        this.currentUrl = null;
                        reject(error);
                    });

                }).catch(error => {
                    console.error('❌ URL alma hatası:', error);
                    reject(error);
                });

            } catch (error) {
                console.error('❌ Müzik çalma hatası:', error);
                this.isPlaying = false;
                this.currentUrl = null;
                reject(error);
            }
        });
    }

    // SES SEVİYESİ KONTROLÜ - YENİ
    setVolume(volume) {
        if (volume < 0 || volume > 100) {
            throw new Error('Ses seviyesi 0-100 arasında olmalı');
        }
        
        this.currentVolume = volume;
        console.log('🔊 Ses seviyesi ayarlandı:', volume + '%');

        // Eğer müzik çalıyorsa, yeniden başlat
        if (this.isPlaying && this.currentProcess && this.currentUrl) {
            console.log('🔄 Ses seviyesi değişti, müzik yeniden başlatılıyor...');
            this.stop();
            
            // Kısa süre sonra aynı şarkıyı yeni ses seviyesiyle çal
            setTimeout(() => {
                if (this.currentUrl) {
                    this.playYouTubeMusic(this.currentUrl)
                        .catch(error => console.error('Ses ayarı hatası:', error));
                }
            }, 500);
        }
        
        return this.currentVolume;
    }

    getAudioUrl(youtubeUrl) {
        return new Promise((resolve, reject) => {
            const ytdlp = spawn('py', [
                '-m', 'yt_dlp',
                '-g', '-f', 'bestaudio',
                '--no-warnings',
                youtubeUrl
            ], { shell: true });

            let audioUrl = '';
            let errorOutput = '';

            ytdlp.stdout.on('data', (data) => {
                audioUrl += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ytdlp.on('close', (code) => {
                if (code === 0 && audioUrl.trim()) {
                    resolve(audioUrl.trim());
                } else {
                    reject(new Error(`URL alınamadı: ${errorOutput || 'Bilinmeyen hata'}`));
                }
            });

            setTimeout(() => {
                if (!ytdlp.killed) {
                    ytdlp.kill();
                    reject(new Error('Zaman aşımı'));
                }
            }, 15000);
        });
    }

    findVLCPath() {
        const vlcPaths = [
            'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
            'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
        ];

        for (const path of vlcPaths) {
            if (fs.existsSync(path)) {
                return path;
            }
        }
        return null;
    }

    stop() {
        if (this.currentProcess) {
            console.log('⏹️ Müzik durduruluyor...');
            this.currentProcess.kill();
            this.currentProcess = null;
            this.isPlaying = false;
        }
    }

    getIsPlaying() {
        return this.isPlaying;
    }

    getCurrentVolume() {
        return this.currentVolume;
    }
}

// Global instance
const musicPlayer = new MusicPlayer();

// Test
if (require.main === module) {
    console.log('=== MÜZİK ÇALMA TESTİ ===');
    musicPlayer.playYouTubeMusic('https://www.youtube.com/watch?v=Eg6gKLXA30U')
        .then(() => {
            console.log('🎉 TEST BAŞARILI! Müzik bitti.');
        })
        .catch(error => {
            console.log('💥 TEST HATASI:', error.message);
        });
}

module.exports = musicPlayer;
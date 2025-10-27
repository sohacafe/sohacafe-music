const { spawn } = require('child_process');
const fs = require('fs');

class MusicPlayer {
    constructor() {
        this.currentProcess = null;
        this.isPlaying = false;
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

                    // 3. ADIM: VLC'yi ses URL'si ile başlat (SES KONTROLSÜZ)
                    const fullCommand = `"${vlcPath}" "${audioUrl}" --play-and-exit --no-video --quiet`;
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
                        resolve(); // Müzik bitti, promise'i çöz
                    });

                    this.currentProcess.on('error', (error) => {
                        console.error('❌ VLC hatası:', error);
                        this.currentProcess = null;
                        this.isPlaying = false;
                        reject(error);
                    });

                }).catch(error => {
                    console.error('❌ URL alma hatası:', error);
                    reject(error);
                });

            } catch (error) {
                console.error('❌ Müzik çalma hatası:', error);
                this.isPlaying = false;
                reject(error);
            }
        });
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
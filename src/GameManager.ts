import { SceneManager } from './SceneManager';
import { PhysicsWorld } from './Physics/PhysicsWorld';
import { CityBuilder } from './World/CityBuilder';
import { WeatherSystem, WeatherType } from './World/WeatherSystem';
import { Player } from './Entities/Player';
import { Enemy } from './Entities/Enemy';
import { Bullet } from './Entities/Bullet';
import stageData from '../stages.json';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

interface Stage {
    id: number;
    name: string;
    lat: number;
    lon: number;
}

enum IntroState {
    SPLASH,
    STORY,
    CONTROLS,
    PLAYING
}

export class GameManager {
    private sceneManager: SceneManager;
    private physicsWorld: PhysicsWorld;
    private cityBuilder: CityBuilder;
    private weatherSystem: WeatherSystem;
    private player: Player | null = null;
    private enemies: Enemy[] = [];
    private bullets: Bullet[] = [];

    private stages: Stage[] = stageData;
    private currentStageIndex: number = 0;
    private score: number = 0;
    private totalEnemiesDown: number = 0;
    private enemiesSpawnedInStage: number = 0;
    private readonly killsToWin: number = 5; // 5 enemies per stage (Cumulative total tracked separately)

    private weatherTimer: number = 10;
    private hasTakenOff: boolean = false;
    private spawnTimer: number = 0;
    private readonly spawnDelay: number = 2; // Spawn every 2 seconds

    // Siren & Warning Sound
    private sirenCtx: AudioContext | null = null;
    private sirenOsc: OscillatorNode | null = null;
    private sirenGain: GainNode | null = null;
    private isSirenPlaying: boolean = false;
    private isSpacePressed: boolean = false;
    private spacePressCount: number = 0;
    private currentWarningText: string = "";
    private isWarningDismissed: boolean = false;

    private introState: IntroState = IntroState.SPLASH;
    private typingInterval: any = null;

    // Audio
    private bgm: HTMLAudioElement;
    private isMusicOn: boolean = true;

    // Mobile
    public isMobile: boolean = false;
    private joystickData = { active: false, startX: 0, startY: 0, currentX: 0, currentY: 0 };
    private isMobileShootPressed: boolean = false;

    private isGameStarted: boolean = false;
    private startTimer: number = 5.0; // Not used exactly the same way now

    constructor() {
        // Detect Mobile first so subsystems can react
        this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 1000;

        this.sceneManager = new SceneManager(this);
        this.physicsWorld = new PhysicsWorld();
        this.cityBuilder = new CityBuilder(this.sceneManager, this.physicsWorld);
        this.weatherSystem = new WeatherSystem(this.sceneManager);

        // Background Music
        this.bgm = new Audio('/bg.m4a');
        this.bgm.loop = true;
        this.bgm.volume = 0.5;

        // BGM Toggle Button
        const toggleBtn = document.getElementById('bgm-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleBGM());
        }

        if (this.isMobile) {
            document.body.classList.add('mobile-touch');
            this.setupMobileInput();
        }

        this.player = new Player(this.sceneManager, this.physicsWorld);

        // Preload sounds
        Bullet.preload();
        Player.preloadSound();

        this.setupIntroInput();

        // Auto-transition from Splash to Story after 2 seconds
        setTimeout(() => {
            if (this.introState === IntroState.SPLASH) {
                this.transitionToStory();
            }
        }, 2000);

        // Listen for shoot (Semi-Auto: 1 press = 1 shot)
        window.addEventListener('keydown', (e) => {
            if (!this.isGameStarted) return; // Handled by setupIntroInput

            if (e.code === 'Space') {
                // Proactively resume context on first interaction
                Bullet.resumeContext();
                Player.resumeContext();

                // Prevent triggering focused UI buttons (like Restart)
                e.preventDefault();

                if (!this.isGameStarted) {
                    this.startGame();
                    return;
                }

                if (!this.isSpacePressed) {
                    this.shoot();
                    this.isSpacePressed = true;
                    this.spacePressCount++;

                    // Dismiss messages if pressed 3 times
                    if (this.spacePressCount >= 3) {
                        // Dismiss center message
                        const msg = document.getElementById('center-message');
                        if (msg) msg.classList.remove('visible');

                        // Dismiss warning overlay
                        this.isWarningDismissed = true;
                        const warningEl = document.getElementById('warning-overlay');
                        if (warningEl) {
                            warningEl.classList.remove('visible');
                            this.stopSiren();
                        }
                    }
                }
            } else if (e.code === 'ShiftLeft') {
                // Proactively resume context on first interaction for afterburner
                Player.resumeContext();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.isSpacePressed = false;
            }
        });

        if (this.player) {
            this.player.onDie = () => this.handleMissionFailed();
        }

        // UI Buttons
        document.getElementById('btn-restart')?.addEventListener('click', (e) => {
            (e.target as HTMLElement).blur();
            this.restartGame();
        });
        document.getElementById('btn-exit')?.addEventListener('click', (e) => {
            (e.target as HTMLElement).blur();
            this.exitGame();
        });

        // Event-Driven Collision Handling (to prevent "stuck" aircraft)
        if (this.player) {
            this.player.body.addEventListener('collide', (event: any) => {
                const otherBody = event.body;
                const enemy = (otherBody as any).entity;

                if (enemy instanceof Enemy && !enemy.isDead && this.player && !this.player.isDead) {
                    console.log("Collision Event: Enemy hit player!");

                    // Find index to remove from array
                    const index = this.enemies.indexOf(enemy);
                    if (index !== -1) {
                        this.handleEnemyDestruction(enemy, index, true); // true = isCollision
                    }
                } else if (this.player && !this.player.isDead) {
                    // Environmental Collision (World/Buildings/Trees)
                    // damage = maxHp / 3
                    const damage = this.player.maxHp / 3;
                    this.player.takeDamage(damage);
                    console.log("Player hit environment! Damage:", damage);
                }
            });
        }

        this.initRadarCompass();
        this.initStage(true); // Initial load: Reset Player

        // Initial Weather
        this.weatherSystem.setWeather(WeatherType.CLEAR);
    }

    private initRadarCompass() {
        const radar = document.getElementById('radar');
        if (!radar) return;

        const labels = ['N', 'E', 'S', 'W'];
        labels.forEach(label => {
            const el = document.createElement('div');
            el.className = 'radar-label';
            el.id = `radar-${label}`;
            el.textContent = label;
            radar.appendChild(el);
        });
    }

    private initStage(resetPlayer: boolean = true) {
        const stage = this.stages[this.currentStageIndex];
        console.log(`Loading Stage ${stage.id}: ${stage.name}`);

        // Use default if lat/lon missing or invalid
        const lat = stage.lat || 0;
        const lon = stage.lon || 0;

        this.enemiesSpawnedInStage = 0;
        this.updateHUD();

        // Generate City
        // If transitioning (resetPlayer=false), generate around current player pos
        if (this.player && !resetPlayer) {
            this.cityBuilder.generateCity(lat, lon, this.player.mesh.position);
        } else {
            this.cityBuilder.generateCity(lat, lon); // Default 0,0
        }

        // Reset Player Physics if needed (Initial Load)
        if (resetPlayer && this.player) {
            // Position: (100, 2, 500) = Runway Start (Center X=100, End Z=500, Alt=2)
            this.player.body.position.set(100, 2, 500);
            this.player.body.velocity.set(0, 0, 0);
            this.player.body.angularVelocity.set(0, 0, 0);
            this.player.body.quaternion.set(0, 0, 0, 1);
        }

        // Clear old entities
        this.enemies.forEach(e => e.dispose());
        this.enemies = [];
        this.bullets.forEach(b => b.dispose());
        this.bullets = [];

        // No initial enemies
        // this.spawnEnemies(); 
    }

    private spawnEnemy() {
        if (!this.player) return;

        this.enemiesSpawnedInStage++;
        const pPos = this.player.mesh.position;
        const playerSpeedKmh = this.player.body.velocity.length() * 3.6;

        // TAIL-CHASE SCENARIO: 40% chance if player is flying fast (> 500km/h)
        // FORCE INTERCEPT for first 3 spawns to ensure they fly towards player
        let isTailChase = playerSpeedKmh > 500 && Math.random() < 0.4;
        if (this.enemiesSpawnedInStage <= 3) isTailChase = false;

        let x: number, y: number, z: number;
        let initialQuat: THREE.Quaternion | undefined;
        let initialSpeedMs: number = 0;

        if (isTailChase) {
            // Spawn ahead of player, facing same way (showing tail)
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion);
            const dist = 300 + Math.random() * 300; // 300m - 600m ahead
            const spawnPos = pPos.clone().add(forward.multiplyScalar(dist));

            x = spawnPos.x;
            y = Math.max(50, spawnPos.y + (Math.random() - 0.5) * 100);
            z = spawnPos.z;

            initialQuat = this.player.mesh.quaternion.clone();
            initialSpeedMs = 500 / 3.6; // Start at ~500km/h for "discovery" feel
        } else {
            // STANDARD INTERCEPT SCENARIO: 70% chance ahead, 30% random
            // FORCE AHEAD for first 3 spawns
            let isAhead = Math.random() < 0.7;
            if (this.enemiesSpawnedInStage <= 3) isAhead = true;

            let angle: number;

            if (isAhead) {
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion);
                const baseAngle = Math.atan2(forward.x, forward.z);
                angle = baseAngle + (Math.random() - 0.5) * Math.PI / 2;
            } else {
                angle = Math.random() * Math.PI * 2;
            }

            const dist = 600 + Math.random() * 600;
            x = pPos.x + Math.sin(angle) * dist;
            z = pPos.z + Math.cos(angle) * dist;
            y = Math.max(50, pPos.y + (Math.random() - 0.5) * 200);
        }

        const enemy = new Enemy(this.sceneManager, this.physicsWorld, new CANNON.Vec3(x, y, z), this.player.mesh.position, initialQuat);

        if (initialSpeedMs > 0) {
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(enemy.mesh.quaternion);
            enemy.body.velocity.set(forward.x * initialSpeedMs, forward.y * initialSpeedMs, forward.z * initialSpeedMs);
        }

        this.enemies.push(enemy);
    }

    private shoot() {
        if (!this.player) return;

        // Get player position and direction
        const pos = this.player.mesh.position.clone();
        // Offset slightly forward
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion);
        pos.add(forward.multiplyScalar(2));

        // Calculate Aim Point (Raycast)
        let aimPoint: THREE.Vector3 | null = null;
        if (!this.lockedTarget) {
            // Raycast against ground (Plane at y=0)
            if (forward.y < 0) { // Pointing down
                const t = -pos.y / forward.y;
                if (t > 0) {
                    aimPoint = pos.clone().add(forward.clone().multiplyScalar(t));
                }
            }

            if (!aimPoint) {
                // If aiming skyward, pick a point far away
                aimPoint = pos.clone().add(forward.clone().multiplyScalar(1000));
            }
        }

        const bullet = new Bullet(this.sceneManager, this.physicsWorld, pos, this.player.mesh.quaternion.clone(), this.lockedTarget, aimPoint);
        bullet.owner = this.player; // Flag as player-owned
        this.bullets.push(bullet);
    }

    public update() {
        const dt = 1 / 60;

        if (this.introState !== IntroState.PLAYING) {
            // Minimal updates for visuals if needed
            this.sceneManager.update(dt, this.player?.mesh, 0);
            return;
        }

        if (!this.isGameStarted) {
            // This is the cinematic transition AFTER the intro sequence
            this.startTimer -= dt;
            if (this.startTimer <= 0) {
                this.startGame();
            }
            this.physicsWorld.update(dt);
            if (this.player) {
                this.player.update(dt);
                this.cityBuilder.update(this.player.mesh.position);
                this.weatherSystem.update(dt, this.player.mesh.position);
                this.updateFlightInstruments();
            }
            this.sceneManager.update(dt, this.player?.mesh, 0);
            return;
        }

        // --- Mobile Joystick Input Mapping ---
        if (this.isMobile && this.player && this.joystickData.active) {
            // Normalize joystick input (-1 to 1)
            const dx = (this.joystickData.currentX - this.joystickData.startX) / 60; // Max 60px radius
            const dy = (this.joystickData.currentY - this.joystickData.startY) / 60;

            const clampedX = Math.max(-1, Math.min(1, dx));
            const clampedY = Math.max(-1, Math.min(1, dy));

            // Map to player input
            this.player.input.left = clampedX < -0.2;
            this.player.input.right = clampedX > 0.2;
            this.player.input.up = clampedY < -0.2;
            this.player.input.down = clampedY > 0.2;
        }

        if (this.isMobile && this.player) {
            // Firing Logic (Semi-Auto) - Moved outside joystick check to work independently
            if (this.player.input.shoot) {
                if (!this.isMobileShootPressed) {
                    this.shoot();
                    this.isMobileShootPressed = true;
                    // Resume audio context for firing sound if needed
                    Bullet.resumeContext();
                    Player.resumeContext();
                }
            } else {
                this.isMobileShootPressed = false;
            }
        }

        this.physicsWorld.update(dt);

        if (this.player) {
            this.player.update(dt);

            // Calculate Current Speed for visuals
            const vel = this.player.body.velocity;
            const speedMs = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
            const speedKmh = speedMs * 3.6;

            this.sceneManager.update(dt, this.player.mesh, speedKmh);

            // Infinite World Update
            this.cityBuilder.update(this.player.mesh.position);

            // Weather Update
            this.weatherSystem.update(dt, this.player.mesh.position);

            // Update Flight Instruments (Includes Warnings & Tutorials)
            this.updateFlightInstruments();

            // Takeoff Check
            if (!this.hasTakenOff && this.player.mesh.position.y > 10) {
                this.hasTakenOff = true;
                this.player.hasTakenOff = true;
                console.log("Takeoff confirmed! Engaging enemies.");
            }

            // Spawn Logic (Maintain 3-10 Enemies)
            if (this.hasTakenOff && this.score < this.killsToWin) {
                const currentCount = this.enemies.length;
                let needed = false;

                if (currentCount < 3) {
                    this.spawnTimer = this.spawnDelay + 1;
                    needed = true;
                } else if (currentCount < 10) {
                    this.spawnTimer += dt;
                    needed = true;
                }

                if (needed && this.spawnTimer > this.spawnDelay) {
                    this.spawnTimer = 0;
                    this.spawnEnemy();
                }
            }
        } else {
            this.sceneManager.update(dt);
        }

        // Weather Cycle
        this.weatherTimer -= dt;
        if (this.weatherTimer <= 0) {
            this.weatherTimer = 10;
            this.changeWeather();
        }

        // Update Enemies
        const playerPos = this.player ? this.player.mesh.position : new THREE.Vector3(0, 0, 0);
        const playerVel = this.player ? this.player.body.velocity : new CANNON.Vec3(0, 0, 0);

        let aggressiveCount = 0;
        this.enemies.forEach(e => {
            if (e.isAggressive) aggressiveCount++;
        });

        this.enemies.forEach((e, index) => {
            if (aggressiveCount < 1 && !e.isAggressive) {
                e.isAggressive = true;
                aggressiveCount++;
            }

            if (!(e as any).onShoot) {
                (e as any).onShoot = (spawnPos: THREE.Vector3, quat: THREE.Quaternion) => {
                    const bullet = new Bullet(
                        this.sceneManager,
                        this.physicsWorld,
                        spawnPos,
                        quat,
                        this.player,
                        null
                    );
                    bullet.owner = e;
                    this.bullets.push(bullet);
                };
            }

            e.update(dt, playerPos, playerVel);

            if (e.isDead) {
                e.isDead = false;
                this.handleEnemyDestruction(e, index, false);
                return;
            }

            const dist = e.mesh.position.distanceTo(playerPos);
            if (dist > 2500) {
                e.dispose();
                this.enemies.splice(index, 1);
                this.spawnEnemy();
                return;
            }

            if (e.mesh.position.y < 20) {
                this.handleEnemyDestruction(e, index, false);
                return;
            }
        });

        // Update Bullets & Collision
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.update(dt);
            if (b.isDead) {
                b.dispose();
                this.bullets.splice(i, 1);
                continue;
            }

            if (this.player && !this.player.isDead && b.owner !== this.player) {
                const distToPlayer = b.mesh.position.distanceTo(this.player.mesh.position);
                if (distToPlayer < 5) {
                    this.player.takeDamage(0.5);
                    b.explode();
                    b.dispose();
                    this.bullets.splice(i, 1);
                    continue;
                }
            }

            for (let j = this.enemies.length - 1; j >= 0; j--) {
                const e = this.enemies[j];
                const dist = b.mesh.position.distanceTo(e.mesh.position);
                if (dist < 3) {
                    e.dispose();
                    this.enemies.splice(j, 1);
                    b.explode();
                    Bullet.playExplosionSound(0.6);
                    b.dispose();
                    this.addScore();
                    break;
                }
            }
        }

        this.updateRadar();
        this.updateTargetLock();
    }

    private lockedTarget: any = null;

    private updateTargetLock() {
        if (!this.player) return;

        const reticle = document.getElementById('target-reticle');
        if (!reticle) return;

        const camera = this.sceneManager.camera;

        // Calculate Aim Point (Boresight) - Use a closer point for better visual offset in front of nose
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion);
        // Projecting 200m ahead typically places it clearly ahead of the aircraft body in the UI
        const aimDistance = 200;
        const aimPos = this.player.mesh.position.clone().add(forward.multiplyScalar(aimDistance));

        // Project Aim Point to Screen
        const screenAim = aimPos.clone().project(camera);

        const aimX = (screenAim.x * 0.5 + 0.5) * window.innerWidth;
        const aimY = (-(screenAim.y * 0.5) + 0.5) * window.innerHeight;

        // Visuals: Move Reticle to projected aim point
        reticle.style.left = `${aimX}px`;
        reticle.style.top = `${aimY}px`;

        let bestTarget: any = null;
        let bestDist = Infinity;

        const frustum = new THREE.Frustum();
        const projScreenMatrix = new THREE.Matrix4();
        projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreenMatrix);

        this.enemies.forEach(enemy => {
            if (!frustum.containsPoint(enemy.mesh.position)) return;

            const pos = enemy.mesh.position.clone();
            pos.project(camera);

            const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
            const y = (-(pos.y * 0.5) + 0.5) * window.innerHeight;

            // Check if inside reticle (relative to aimX, aimY)
            const dx = Math.abs(x - aimX);
            const dy = Math.abs(y - aimY);

            // Reticle is 120px, so radius is 60px
            if (dx < 60 && dy < 60) {
                const distToCam = enemy.mesh.position.distanceTo(camera.position);
                if (distToCam < bestDist) {
                    bestDist = distToCam;
                    bestTarget = enemy;
                }
            }
        });

        this.lockedTarget = bestTarget;

        if (this.lockedTarget) {
            reticle.style.borderColor = '#00ff00';
            reticle.style.boxShadow = '0 0 20px #00ff00, inset 0 0 20px #00ff00'; // Intense Green
            reticle.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
        } else {
            reticle.style.borderColor = 'rgba(0, 255, 0, 0.6)';
            reticle.style.boxShadow = '0 0 10px rgba(0, 255, 0, 0.4)';
            reticle.style.backgroundColor = 'transparent';
        }
    }

    private changeWeather() {
        // Weighted Random: 20% Clear, 20% Snow, 30% Rain, 30% Thunder
        const rand = Math.random();
        let next: WeatherType;
        if (rand < 0.2) next = WeatherType.CLEAR;
        else if (rand < 0.4) next = WeatherType.SNOW;
        else if (rand < 0.7) next = WeatherType.RAIN;
        else next = WeatherType.THUNDER;

        this.weatherSystem.setWeather(next);
    }

    private updateRadar() {
        if (!this.player) return;
        const radar = document.getElementById('radar');
        if (!radar) return;

        // Player Rotation (Yaw)
        const euler = new THREE.Euler();
        euler.setFromQuaternion(this.player.mesh.quaternion, 'YXZ');
        const yaw = euler.y; // Rotation around Y axis in radians

        // Update Compass
        const radius = 65; // Slightly inside the 75px radius


        // Map 3D direction to 2D radar angle (0 is Up/North)
        const dirs = [
            { id: 'radar-N', offset: 0 },
            { id: 'radar-W', offset: Math.PI / 2 },
            { id: 'radar-S', offset: Math.PI },
            { id: 'radar-E', offset: -Math.PI / 2 }
        ];

        dirs.forEach(d => {
            const el = document.getElementById(d.id);
            if (el) {
                // Determine angle relative to player heading
                // If player rotates Left (Positive Yaw), North should rotate Right (Positive visual angle? No, CW)

                // Angle = D Offset + Yaw
                const angle = d.offset + yaw;

                // Convert to x/y. 
                // 0 is North (Up). 
                // x = sin(angle)
                // y = -cos(angle) (because y goes down)

                const px = Math.sin(angle) * radius;
                const py = -Math.cos(angle) * radius; // Up is negative Y

                el.style.left = `${75 + px}px`;
                el.style.top = `${75 + py}px`;
            }
        });

        // Clear old blips (except player - simpler to clear all blips and redraw)
        const blips = radar.getElementsByClassName('radar-blip');
        while (blips[0]) {
            blips[0].parentNode!.removeChild(blips[0]);
        }

        const range = 500; // 500 meters range
        const radarRadius = 75; // radar radius in px (150px / 2)


        this.enemies.forEach(e => {
            if (!this.player) return; // Type guard
            const relPos = e.mesh.position.clone().sub(this.player.mesh.position);

            // Rotate relative to player heading to make "Up" on radar be "Forward"
            relPos.applyQuaternion(this.player.mesh.quaternion.clone().invert());

            // Check range
            // Ignore Y (altitude) for 2D radar, use X and Z relative.
            // In Three.js: -Z is forward, X is right.
            // Canvas coords: Center (75, 75). 
            // Forward (-Z) -> Up (-Y pixel). Right (+X) -> Right (+X pixel).

            const dist = Math.sqrt(relPos.x * relPos.x + relPos.z * relPos.z);
            if (dist < range) {
                const scale = radarRadius / range;
                const px = relPos.x * scale;
                const py = relPos.z * scale; // z in 3d is y on 2d plane (forward/back)

                const blip = document.createElement('div');
                blip.className = 'radar-blip';
                blip.style.left = `${75 + px}px`;
                blip.style.top = `${75 + py}px`;
                radar.appendChild(blip);
            } else {
                // Out of range? Clamp to edge like Home Base
                // This ensures "always visible on radar"
                const len = Math.max(0.1, dist);
                const scale = radarRadius / len;
                const px = relPos.x * scale;
                const py = relPos.z * scale;

                const blip = document.createElement('div');
                blip.className = 'radar-blip';
                blip.style.left = `${75 + px}px`;
                blip.style.top = `${75 + py}px`;
                // Maybe dim it slightly or make it smaller? 
                // User just said "visible". Standard blip is fine, maybe slightly smaller.
                blip.style.opacity = '0.7';
                radar.appendChild(blip);
            }
        });

        // --- Home Base Indicator (Runway Start) ---
        // Home Base Position: (100, 2, 500)
        const homePos = new THREE.Vector3(100, 2, 500);
        const relHome = homePos.clone().sub(this.player.mesh.position);
        relHome.applyQuaternion(this.player.mesh.quaternion.clone().invert());

        const distHome = Math.sqrt(relHome.x * relHome.x + relHome.z * relHome.z);
        let hx = 0;
        let hy = 0;

        if (distHome < range) {
            const scale = radarRadius / range;
            hx = relHome.x * scale;
            hy = relHome.z * scale;
        } else {
            // Clamp to edge (Radius 75)
            const len = Math.max(0.1, distHome); // prevent div by zero
            hx = (relHome.x / len) * radarRadius;
            hy = (relHome.z / len) * radarRadius;
        }

        const homeBlip = document.createElement('div');
        homeBlip.className = 'radar-blip home-base';
        homeBlip.style.left = `${75 + hx}px`;
        homeBlip.style.top = `${75 + hy}px`;

        radar.appendChild(homeBlip);
    }

    private updateFlightInstruments() {
        if (!this.player || this.player.isDead) {
            this.stopSiren();
            const warningEl = document.getElementById('warning-overlay');
            if (warningEl) warningEl.classList.remove('visible');
            return;
        }
        const altEl = document.getElementById('alt-val');
        const spdEl = document.getElementById('spd-val');
        const altFill = document.getElementById('alt-fill');
        const spdFill = document.getElementById('spd-fill');

        const altitude = Math.max(0, this.player.body.position.y - 2.0); // Offset for ground level
        const vel = this.player.body.velocity;
        const speedMs = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        const speedKmh = speedMs * 3.6;

        if (altEl) altEl.textContent = `${Math.round(altitude)} m`;
        if (spdEl) spdEl.textContent = `${Math.round(speedKmh)} km/h`;

        // Update Bars
        // Max Alt: 1,000 m (Limited)
        if (altFill) {
            const pct = Math.min(100, (altitude / 1000) * 100);
            altFill.style.height = `${pct}%`;
        }

        // Max Speed: 800 km/h (Adjusted for visual)
        if (spdFill) {
            const pct = Math.min(100, (speedKmh / 800) * 100);
            spdFill.style.height = `${pct}%`;
        }

        // --- Cruise Status (SPD HOLD) ---
        const cruiseEl = document.getElementById('cruise-status');
        if (cruiseEl) {
            const isCruiseActive = this.player.targetCruiseSpeed > 0 &&
                !this.player.input.throttleUp &&
                !this.player.input.throttleDown;

            if (isCruiseActive) {
                cruiseEl.textContent = `SPD HOLD: ${Math.round(this.player.targetCruiseSpeed * 3.6)} km/h`;
                cruiseEl.classList.add('visible');
            } else {
                cruiseEl.classList.remove('visible');
            }
        }

        // --- Flight Safety Warnings & Takeoff Tutorials ---
        const warningEl = document.getElementById('warning-overlay');
        const shiftHint = document.getElementById('shift-hint');
        const pitchHint = document.getElementById('pitch-hint');

        // Hide hints by default
        if (shiftHint) shiftHint.classList.remove('visible');
        if (pitchHint) pitchHint.classList.remove('visible');

        if (warningEl) {
            let warningText = "";
            let shouldShow = false;
            let useHtml = false;
            let isHazard = false;

            // --- Hazard Detection (High Priority) ---
            // 1. Missile Detection (Only threats from others)
            const incomingMissile = this.bullets.find(b => {
                if (b.isDead || b.owner === this.player) return false;
                const d = b.mesh.position.distanceTo(this.player!.mesh.position);
                // Within 300m and moving towards us (simple dist check for now)
                return d < 300;
            });

            if (incomingMissile) {
                warningText = "MISSILE!!!";
                shouldShow = true;
                isHazard = true;
            }

            // 2. Traffic Detection (If no missile)
            if (!shouldShow) {
                const closeEnemy = this.enemies.find(e => {
                    if (e.isDead) return false;
                    const d = e.mesh.position.distanceTo(this.player!.mesh.position);
                    return d < 100; // 100m proximity
                });
                if (closeEnemy) {
                    warningText = "TRAFFIC!!!";
                    shouldShow = true;
                    isHazard = true;
                }
            }

            // Runway Boundaries (Z: -350 to 550, X: 70 to 130)
            const pPos = this.player.body.position;
            const isOnGround = !this.hasTakenOff && altitude < 3.0;

            if (isOnGround && !isHazard) {
                // 1. Runway Exit Crash Logic
                const offX = pPos.x < 70 || pPos.x > 130;
                const offZ = pPos.z < -350 || pPos.z > 550;

                if (offX || offZ) {
                    console.log("Player exited runway on ground! Crash.");
                    this.player.takeDamage(100); // Instant death
                    return;
                }

                // 2. Takeoff Tutorials (Only on Runway)
                const isNearingEnd = pPos.z < 100; // Halfway through the "exit" part of runway
                const isFastEnough = speedKmh > 350;
                const isWrongPitch = this.player.input.up; // Pressing Up Arrow (Pitch Down)
                const isRightPitch = this.player.input.down; // Pressing Down Arrow (Pitch Up)

                if (!this.player.input.throttleUp && speedKmh < 100) {
                    // Show L-Shift hint if stationary or slow (Desktop only)
                    if (shiftHint && !this.isMobile) {
                        shiftHint.classList.add('visible');
                    }
                } else if (isFastEnough || isNearingEnd || isWrongPitch || isRightPitch) {
                    // Show Down Arrow (PULL UP) hint
                    if (pitchHint) {
                        pitchHint.classList.add('visible');
                        const hintText = pitchHint.querySelector('.hint-text');
                        if (this.isMobile && hintText) {
                            hintText.textContent = 'Pull Joystick Down';
                        }
                    }

                    if (isFastEnough || isNearingEnd || isWrongPitch) {
                        warningText = "PULL UP!!!";
                        shouldShow = true;
                    }
                }
            } else if (!isHazard) {
                // Airborne Warnings
                if (altitude < 30 && this.hasTakenOff) {
                    warningText = "PULL UP!!!";
                    shouldShow = true;
                } else if (speedKmh < 100 && this.hasTakenOff) {
                    warningText = "STALL!!!";
                    shouldShow = true;
                }
            }

            if (shouldShow) {
                if (warningText !== this.currentWarningText) {
                    this.currentWarningText = warningText;
                    this.isWarningDismissed = false;
                    this.spacePressCount = 0;
                }

                if (!this.isWarningDismissed) {
                    if (useHtml) warningEl.innerHTML = warningText;
                    else warningEl.textContent = warningText;

                    warningEl.classList.add('visible');
                    if (isHazard) warningEl.classList.add('flicker');
                    else warningEl.classList.remove('flicker');

                    this.startSiren();
                } else {
                    warningEl.classList.remove('visible');
                    warningEl.classList.remove('flicker');
                    this.stopSiren();
                }
            } else {
                warningEl.classList.remove('visible');
                warningEl.classList.remove('flicker');
                this.stopSiren();
                this.currentWarningText = "";
                this.isWarningDismissed = false;
            }
        }
    }

    private startSiren() {
        if (this.isSirenPlaying) return;
        this.isSirenPlaying = true;

        if (!this.sirenCtx) {
            this.sirenCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        }

        // Web Audio can only start on user interaction, but since they press keys to fly, it should be fine.
        if (this.sirenCtx.state === 'suspended') {
            this.sirenCtx.resume();
        }

        this.sirenOsc = this.sirenCtx.createOscillator();
        this.sirenGain = this.sirenCtx.createGain();

        this.sirenOsc.type = 'sawtooth';

        // Procedural "Whoop Whoop"
        const now = this.sirenCtx.currentTime;
        this.sirenOsc.frequency.setValueAtTime(400, now);

        // Loop the frequency sweep
        const sweepDuration = 0.5;
        for (let i = 0; i < 100; i++) {
            const time = now + i * sweepDuration;
            this.sirenOsc.frequency.exponentialRampToValueAtTime(800, time + sweepDuration * 0.8);
            this.sirenOsc.frequency.setValueAtTime(400, time + sweepDuration);
        }

        this.sirenGain.gain.setValueAtTime(0.2, now);

        this.sirenOsc.connect(this.sirenGain);
        this.sirenGain.connect(this.sirenCtx.destination);

        this.sirenOsc.start();
    }

    private stopSiren() {
        if (!this.isSirenPlaying) return;
        this.isSirenPlaying = false;

        if (this.sirenOsc) {
            this.sirenOsc.stop();
            this.sirenOsc.disconnect();
            this.sirenOsc = null;
        }
    }

    private handleEnemyDestruction(e: Enemy, index: number, isCollision: boolean = true) {
        if (e.isDead) return;
        e.isDead = true; // Mark to prevent double-proc

        console.log("Enemy Destroyed!");
        e.dispose();
        this.enemies.splice(index, 1);
        this.spawnEnemy();

        // Trigger an explosion at enemy position
        const bulletMock = new Bullet(this.sceneManager, this.physicsWorld, e.mesh.position.clone(), e.mesh.quaternion.clone(), null, null);
        bulletMock.explode();
        bulletMock.dispose();

        // Damage player ONLY if it was a physical collision
        if (this.player && isCollision) {
            this.player.takeDamage(1);
        }

        this.addScore();
        Bullet.playExplosionSound(0.6);
    }

    public addScore() {
        this.score++;
        this.totalEnemiesDown++;
        this.updateHUD();
        if (this.score >= this.killsToWin) {
            this.advanceStage(); // Changed from nextStage()
        }
    }

    private setupIntroInput() {
        const handleAnyKey = (e?: any) => {
            if (e && e.preventDefault) e.preventDefault();

            // Start BGM on first interaction (browser requirement)
            if (this.isMusicOn && this.bgm.paused) {
                this.bgm.play().catch(err => console.error("BGM Autoplay prevented:", err));
            }

            switch (this.introState) {
                case IntroState.SPLASH:
                    this.transitionToStory();
                    break;
                case IntroState.STORY:
                    this.transitionToControls();
                    break;
                case IntroState.CONTROLS:
                    this.transitionToLaunch();
                    break;
            }
        };

        window.addEventListener('keydown', (e) => {
            if (this.introState !== IntroState.PLAYING) handleAnyKey(e);
        });
        window.addEventListener('mousedown', (e) => {
            if (this.introState !== IntroState.PLAYING) handleAnyKey(e);
        });
        window.addEventListener('touchstart', (e) => {
            if (this.introState !== IntroState.PLAYING) handleAnyKey(e);
        }, { passive: false });
    }

    private transitionToStory() {
        this.introState = IntroState.STORY;
        document.getElementById('screen-splash')?.classList.remove('active');
        document.getElementById('screen-story')?.classList.add('active');

        // Typing effect
        const storyText = `In 2099, massive shadows descended upon the peaceful cities of Earth.\n\nAn unprovoked, indiscriminate strike by an unknown alien fleet.\n\nThe elite pilots of 'Guardians of the Sky,' humanity's last line of defense, took flight, but the skies crumbled beneath the overwhelming technological divide.\n\nAt the precipice of despair, a single, hidden fighter jet awakens.\n\nThis mysterious machine, having rejected every elite pilot, responds to only one biological signature...\n\nYours. A person who had lived a completely ordinary life until today.\n\nThere is nowhere left to run.\n\nYou are the solitary hope destined to pierce these ashen skies and save our world.\n\nLaunch, the final Guardian of the Sky.`;

        const storyEl = document.getElementById('story-content');
        if (!storyEl) return;

        let i = 0;
        this.typingInterval = setInterval(() => {
            if (i < storyText.length) {
                // Handle newlines
                if (storyText[i] === '\n') {
                    storyEl.innerHTML += '<br>';
                } else {
                    storyEl.textContent += storyText[i];
                }
                i++;
            } else {
                clearInterval(this.typingInterval);
            }
        }, 30); // 30ms per character
    }

    private transitionToControls() {
        if (this.typingInterval) clearInterval(this.typingInterval);

        this.introState = IntroState.CONTROLS;
        document.getElementById('screen-story')?.classList.remove('active');
        document.getElementById('screen-controls')?.classList.add('active');
    }

    private transitionToLaunch() {
        this.introState = IntroState.PLAYING;
        document.getElementById('intro-container')?.classList.add('hidden'); // Ensure container is hidden
        // The container needs to be hidden so mouse/clicks can reach the canvas after starting
        const container = document.getElementById('intro-container');
        if (container) {
            container.style.opacity = '0';
            setTimeout(() => container.style.display = 'none', 1500);
        }

        // Start the cinematic fade to runway
        this.startTimer = 1.0; // Shorter delay now that we had an intro
    }

    private toggleBGM() {
        this.isMusicOn = !this.isMusicOn;
        const btn = document.getElementById('bgm-toggle');

        if (this.isMusicOn) {
            this.bgm.play().catch(e => console.error("BGM Resume failed:", e));
            if (btn) {
                btn.textContent = 'MUSIC: ON';
                btn.classList.remove('off');
            }
        } else {
            this.bgm.pause();
            if (btn) {
                btn.textContent = 'MUSIC: OFF';
                btn.classList.add('off');
            }
        }
    }

    private setupMobileInput() {
        const zone = document.getElementById('joystick-zone');
        const pad = document.getElementById('joystick-pad');

        if (zone && pad) {
            const handleTouch = (e: TouchEvent) => {
                e.preventDefault();
                const touch = e.touches[0];
                const rect = zone.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                if (!this.joystickData.active) {
                    this.joystickData.active = true;
                    this.joystickData.startX = centerX;
                    this.joystickData.startY = centerY;
                }

                // Distance from center
                const dx = touch.clientX - centerX;
                const dy = touch.clientY - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const maxLen = 60;

                let targetX = dx;
                let targetY = dy;

                if (dist > maxLen) {
                    targetX = (dx / dist) * maxLen;
                    targetY = (dy / dist) * maxLen;
                }

                this.joystickData.currentX = centerX + targetX;
                this.joystickData.currentY = centerY + targetY;

                pad.style.transform = `translate(calc(-50% + ${targetX}px), calc(-50% + ${targetY}px))`;
            };

            const resetJoystick = () => {
                this.joystickData.active = false;
                pad.style.transform = 'translate(-50%, -50%)';
                if (this.player) {
                    this.player.input.left = false;
                    this.player.input.right = false;
                    this.player.input.up = false;
                    this.player.input.down = false;
                }
            };

            zone.addEventListener('touchstart', handleTouch, { passive: false });
            zone.addEventListener('touchmove', handleTouch, { passive: false });
            zone.addEventListener('touchend', resetJoystick);
            zone.addEventListener('touchcancel', resetJoystick);
        }

        // Action Buttons
        const bindBtn = (id: string, inputKey: keyof typeof Player.prototype.input) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('touchstart', (e) => { e.preventDefault(); if (this.player) (this.player.input as any)[inputKey] = true; }, { passive: false });
            el.addEventListener('touchend', () => { if (this.player) (this.player.input as any)[inputKey] = false; });
        };

        bindBtn('btn-accel', 'throttleUp');
        bindBtn('btn-brake', 'throttleDown');
        bindBtn('btn-fire', 'shoot');
    }

    private startGame() {
        if (this.isGameStarted) return;
        this.isGameStarted = true;

        const startScreen = document.getElementById('start-screen');
        if (startScreen) startScreen.classList.add('hidden');

        const hud = document.getElementById('hud');
        if (hud) hud.classList.add('visible');

        // Initial Start Message
        const stage = this.stages[this.currentStageIndex];
        this.showCenterMessage(`<span class="msg-white">Good Luck</span> to you. Now, save <span class="msg-blue">${stage.name}</span>.`, 4000);
    }

    private advanceStage() { // Renamed from nextStage()
        // 1. Show Completion Message
        const currentStageName = this.stages[this.currentStageIndex].name;
        // Use HTML for colors: Good Job (White) + City (Blue)
        this.showCenterMessage(`<span class="msg-white">Good Job!</span> You have saved <span class="msg-blue">${currentStageName}</span>! Let's Go to the next stage!`, 4000);

        // 2. Delay before Transition
        setTimeout(() => {
            // Advance Stage Index
            this.currentStageIndex = (this.currentStageIndex + 1) % this.stages.length;
            this.score = 0; // Reset Score for next stage

            // 3. Transition (Seamless, No Reset)
            this.initStage(false);

            // 4. Show Start Message for New Stage
            const nextStageName = this.stages[this.currentStageIndex].name;
            setTimeout(() => {
                // Use HTML for colors: Good Luck (White) + City (Blue)
                this.showCenterMessage(`<span class="msg-white">Good Luck</span> to you. Now, save <span class="msg-blue">${nextStageName}</span>.`, 4000);
            }, 1000); // Slight delay after load
        }, 4000);
    }

    private showCenterMessage(text: string, duration: number) {
        const msg = document.getElementById('center-message');
        if (!msg) return;

        this.spacePressCount = 0; // Reset count for new message
        msg.innerHTML = text; // Use innerHTML to allow spans for color
        msg.classList.add('visible');

        setTimeout(() => msg.classList.remove('visible'), duration);
    }

    private handleMissionFailed() {
        // Stop any active sirens
        this.stopSiren();

        // Play Crash Sound (Immediate, Web Audio API)
        Bullet.playExplosionSound(1.0);

        // Show UI after a short delay (Allows the explosion to be visible)
        setTimeout(() => {
            const failScreen = document.getElementById('fail-screen');
            if (failScreen) failScreen.classList.add('visible');
        }, 1500);
    }

    private restartGame() {
        if (!this.player) return;

        const failScreen = document.getElementById('fail-screen');
        if (failScreen) failScreen.classList.remove('visible');

        // Reset Player
        this.player.reset();
        this.player.hasTakenOff = false;

        // Reset Position to Runway
        this.player.body.position.set(100, 2, 500);
        this.player.body.velocity.set(0, 0, 0);
        this.player.body.angularVelocity.set(0, 0, 0);
        this.player.body.quaternion.set(0, 0, 0, 1);
        this.player.mesh.quaternion.set(0, 0, 0, 1);

        // Reset Game State
        this.hasTakenOff = false;
        this.score = 0;
        this.totalEnemiesDown = 0; // Optional: Reset total kills? Or keep? 
        // Let's reset for a true "Restart" feel.
        this.updateHUD();

        // Clear Enemies
        this.enemies.forEach(e => e.dispose());
        this.enemies = [];

        // Stop any siren
        this.stopSiren();

        console.log("Game Restarted from Runway.");
    }

    private exitGame() {
        // For a web game, "Exit" usually means going back to a lobby or just stopping.
        // We'll show a "Thanks for playing" message.
        const failScreen = document.getElementById('fail-screen');
        if (failScreen) {
            const title = document.getElementById('fail-title');
            if (title) {
                title.textContent = "GAME OVER";
                title.style.color = "#aaaaaa";
                title.style.textShadow = "0 0 10px #ffffff";
            }
            const msg = document.getElementById('fail-msg');
            if (msg) msg.textContent = "Thank you for playing!";

            const btns = document.querySelector('.fail-buttons') as HTMLElement;
            if (btns) btns.style.display = 'none';
        }
    }

    private updateHUD() {
        const stage = this.stages[this.currentStageIndex];
        const cityNameEl = document.getElementById('city-name');
        // const stageInfoEl = document.getElementById('stage-info'); // Removed
        // const scoreInfoEl = document.getElementById('score-info'); // Removed
        const enemiesDownEl = document.getElementById('enemies-down-info');

        if (cityNameEl) cityNameEl.textContent = `STAGE ${stage.id}: ${stage.name}`;
        if (enemiesDownEl) enemiesDownEl.textContent = `Enemies Down: ${this.totalEnemiesDown}`;
    }
}

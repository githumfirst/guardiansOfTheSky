import * as THREE from 'three';
import { SceneManager } from '../SceneManager';

export enum WeatherType {
    CLEAR = 'Clear',
    RAIN = 'Rain',
    SNOW = 'Snow',
    THUNDER = 'Thunderstorm'
}

export class WeatherSystem {
    private sceneManager: SceneManager;
    private particleSystem: THREE.Points | null = null;
    private particleGeo: THREE.BufferGeometry | null = null;
    private particleMat: THREE.PointsMaterial | null = null;
    private weatherType: WeatherType = WeatherType.CLEAR;

    private particleCount = 15000;
    private range = 400;

    // Clouds
    private cloudMesh: THREE.InstancedMesh | null = null;
    private cloudCount = 12; // REDUCED CLOUDS (1/4 of 50)
    private cloudRange = 25000; // Wider range for horizon
    private cloudData: { x: number, y: number, z: number, scaleX: number, scaleY: number, scaleZ: number, rotY: number, speed: number }[] = [];

    // Sun
    private sunSprite: THREE.Sprite | null = null;

    // Thunder
    private thunderTimer = 3; // Start sooner
    private lightningBolt: THREE.Mesh | null = null;
    private lightningDisplayTimer = 0;
    private lightningFlash: THREE.PointLight | null = null;
    private ambientFlash: THREE.AmbientLight | null = null; // Add Ambient flash for global effect

    constructor(sceneManager: SceneManager) {
        this.sceneManager = sceneManager;
        this.initClouds();
        this.initSun();

        // Add a global flash light (Point + Ambient)
        this.lightningFlash = new THREE.PointLight(0xaa00ff, 0, 50000); // Purple-ish
        this.lightningFlash.position.set(0, 5000, 0);
        this.sceneManager.scene.add(this.lightningFlash);

        this.ambientFlash = new THREE.AmbientLight(0xffffff, 0);
        this.sceneManager.scene.add(this.ambientFlash);
    }

    private createSunTexture(): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1)'); // Core White
            gradient.addColorStop(0.2, 'rgba(255, 255, 220, 1)'); // Inner Yellow
            gradient.addColorStop(0.5, 'rgba(255, 200, 0, 0.5)'); // Outer Orange Glow
            gradient.addColorStop(1, 'rgba(255, 150, 0, 0)'); // Fade out

            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 64, 64);
        }
        return new THREE.CanvasTexture(canvas);
    }

    private initSun() {
        const mat = new THREE.SpriteMaterial({
            map: this.createSunTexture(),
            color: 0xffffff,
            fog: false,
            transparent: true,
            blending: THREE.AdditiveBlending
        });

        this.sunSprite = new THREE.Sprite(mat);
        // South is +Z. Position far away.
        // Scale it up significantly to be visible
        this.sunSprite.position.set(0, 5000, 10000);
        this.sunSprite.scale.set(4000, 4000, 1);
        this.sceneManager.scene.add(this.sunSprite);
    }

    private initClouds() {
        // Use a simple Box or Sphere for clouds, scaled differently
        // Icosahedron is good for roundness
        const geo = new THREE.IcosahedronGeometry(400, 2);

        // Use standard material to accept color changes per instance? 
        // Actually, MeshBasicMaterial supports vertex colors if we use InstancedMesh.setColorAt
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffffff, // Base color (white)
            transparent: true,
            opacity: 0.8,
            fog: false
        });

        this.cloudMesh = new THREE.InstancedMesh(geo, mat, this.cloudCount);

        const dummy = new THREE.Object3D();
        const color = new THREE.Color();

        for (let i = 0; i < this.cloudCount; i++) {
            const x = (Math.random() - 0.5) * this.cloudRange;
            const y = 5000 + Math.random() * 3000; // Altitude 5km - 8km
            const z = (Math.random() - 0.5) * this.cloudRange;

            // Shape Variety (Favor Flat/Wide)
            const type = Math.floor(Math.random() * 3); // 0, 1, 2

            let sx = 1, sy = 1, sz = 1;

            if (type === 0) { // Flat Wide (Stratus) - Common
                sx = 8 + Math.random() * 8; // Very wide
                sy = 0.5 + Math.random() * 0.5;
                sz = 4 + Math.random() * 4;
            } else if (type === 1) { // Puffy but spread
                sx = 3 + Math.random() * 3;
                sy = 1 + Math.random();
                sz = 3 + Math.random() * 3;
            } else { // Small/Distant
                sx = 1 + Math.random();
                sy = 0.5;
                sz = 1 + Math.random();
            }

            const rotY = Math.random() * Math.PI;
            const speed = 2 + Math.random() * 5;

            this.cloudData.push({ x, y, z, scaleX: sx, scaleY: sy, scaleZ: sz, rotY, speed });

            dummy.position.set(x, y, z);
            dummy.scale.set(sx, sy, sz);
            dummy.rotation.y = rotY;
            dummy.updateMatrix();
            this.cloudMesh.setMatrixAt(i, dummy.matrix);

            // Color Variety (White to Light Grey)
            const gray = 0.9 + Math.random() * 0.1;
            color.setRGB(gray, gray, gray);
            this.cloudMesh.setColorAt(i, color);
        }

        this.cloudMesh.instanceMatrix.needsUpdate = true;
        if (this.cloudMesh.instanceColor) this.cloudMesh.instanceColor.needsUpdate = true;

        this.sceneManager.scene.add(this.cloudMesh);
        this.cloudMesh.frustumCulled = false;
    }

    public setWeather(type: WeatherType) {
        console.log(`Setting Weather: ${type}`);
        this.weatherType = type;

        // Cleanup particles
        if (this.particleSystem) {
            this.sceneManager.scene.remove(this.particleSystem);
            this.particleSystem.geometry.dispose();
            (this.particleSystem.material as THREE.Material).dispose();
            this.particleSystem = null;
        }

        // Setup particles for Rain/Snow/Thunder
        if (type === WeatherType.RAIN || type === WeatherType.SNOW || type === WeatherType.THUNDER) {
            this.createParticles(type);
        }

        // Adjust Scene Lighting/Fog & Sun Visibility
        if (type === WeatherType.CLEAR) {
            this.sceneManager.scene.fog = new THREE.Fog(0x87CEEB, 200, 3000); // Clear day, far visibility
            this.sceneManager.renderer.setClearColor(0x87CEEB);
            if (this.sunSprite) this.sunSprite.visible = true;
            if (this.lightningFlash) this.lightningFlash.intensity = 0;
            if (this.ambientFlash) this.ambientFlash.intensity = 0;

        } else if (type === WeatherType.SNOW) {
            this.sceneManager.scene.fog = new THREE.Fog(0xE5E5E5, 100, 1500); // White fog
            this.sceneManager.renderer.setClearColor(0xE5E5E5);
            if (this.sunSprite) this.sunSprite.visible = false;
            if (this.lightningFlash) this.lightningFlash.intensity = 0;
            if (this.ambientFlash) this.ambientFlash.intensity = 0;

        } else {
            // Rain / Thunder -> Darker but not pitch black
            // Fog should essentially hide the horizon but allow some visibility
            this.sceneManager.scene.fog = new THREE.Fog(0x111122, 50, 1000);
            this.sceneManager.renderer.setClearColor(0x111122);
            if (this.sunSprite) this.sunSprite.visible = false;
        }

        // ... (Cloud Colors logic kept same if needed, or rely on init)
        if (this.cloudMesh) {
            const mat = this.cloudMesh.material as THREE.MeshBasicMaterial;
            const isStorm = (type === WeatherType.RAIN || type === WeatherType.THUNDER);
            if (isStorm) {
                mat.color.setHex(0xaaaaaa); // Slight dim for storm
            } else {
                mat.color.setHex(0xffffff);
            }
        }
    }

    private createParticleTexture(type: WeatherType): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            if (type === WeatherType.RAIN || type === WeatherType.THUNDER) {
                // Rain Streak: Long vertical line/oval
                // Cartoon style - clear solid streak
                ctx.fillStyle = 'rgba(200, 225, 255, 1.0)';
                ctx.beginPath();
                // x, y, radiusX, radiusY, rotation, startAngle, endAngle
                ctx.ellipse(16, 16, 2, 12, 0, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Gradient circle for soft snow look
                const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
                grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
                grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 32, 32);
            }
        }
        const texture = new THREE.CanvasTexture(canvas);
        return texture;
    }

    private createParticles(type: WeatherType) {
        this.particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(this.particleCount * 3);
        const velocities = new Float32Array(this.particleCount);

        for (let i = 0; i < this.particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * this.range;
            positions[i * 3 + 1] = (Math.random() - 0.5) * this.range;
            positions[i * 3 + 2] = (Math.random() - 0.5) * this.range;

            velocities[i] = 10 + Math.random() * 20;
        }

        this.particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.particleGeo.userData = { velocities: velocities };

        const isSnow = type === WeatherType.SNOW;
        const color = isSnow ? 0xffffff : 0x88ccff; // Light Blue rain
        const size = isSnow ? 1.2 : 2.5; // Large streaks
        const opacity = isSnow ? 0.9 : 0.8;

        const texture = this.createParticleTexture(type);

        this.particleMat = new THREE.PointsMaterial({
            color: color,
            size: size,
            map: texture, // Texture depends on weather
            transparent: true,
            opacity: opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: true
        });

        this.particleSystem = new THREE.Points(this.particleGeo, this.particleMat);
        this.sceneManager.scene.add(this.particleSystem);
    }

    public update(dt: number, playerPos: THREE.Vector3) {
        // Move clouds
        if (this.cloudMesh) {
            const dummy = new THREE.Object3D();

            for (let i = 0; i < this.cloudCount; i++) {
                let data = this.cloudData[i];

                // Drift
                data.x += data.speed * dt; // Individual wind speed

                // Infinite Wrapping relative to player
                const dx = data.x - playerPos.x;
                const dz = data.z - playerPos.z;

                if (dx > this.cloudRange / 2) data.x -= this.cloudRange;
                if (dx < -this.cloudRange / 2) data.x += this.cloudRange;
                if (dz > this.cloudRange / 2) data.z -= this.cloudRange;
                if (dz < -this.cloudRange / 2) data.z += this.cloudRange;

                // Update Instance Matrix
                dummy.position.set(data.x, data.y, data.z);
                dummy.scale.set(data.scaleX, data.scaleY, data.scaleZ);
                dummy.rotation.y = data.rotY;
                dummy.updateMatrix();
                this.cloudMesh.setMatrixAt(i, dummy.matrix);
            }
            this.cloudMesh.instanceMatrix.needsUpdate = true;
        }

        // Particle System Logic
        if (this.particleSystem && this.particleGeo) {
            this.particleSystem.position.set(playerPos.x, playerPos.y, playerPos.z);

            const positions = this.particleGeo.attributes.position.array as Float32Array;
            const velocities = this.particleGeo.userData.velocities as Float32Array;

            const isSnow = this.weatherType === WeatherType.SNOW;
            const speedScale = isSnow ? 0.2 : 1.5; // Rain is fast

            for (let i = 0; i < this.particleCount; i++) {
                let speed = velocities[i] * speedScale * dt * 5;

                positions[i * 3 + 1] -= speed;

                if (positions[i * 3 + 1] < -this.range / 2) {
                    positions[i * 3 + 1] = this.range / 2;
                }
            }
            this.particleGeo.attributes.position.needsUpdate = true;
        }

        // Thunder Logic
        if (this.weatherType === WeatherType.THUNDER) {
            this.updateThunder(dt, playerPos);
        } else {
            if (this.lightningFlash) this.lightningFlash.intensity = 0;
            if (this.ambientFlash) this.ambientFlash.intensity = 0;
        }
    }

    private updateThunder(dt: number, playerPos: THREE.Vector3) {
        this.thunderTimer -= dt;

        // Lightning visual duration
        if (this.lightningBolt) {
            this.lightningDisplayTimer -= dt;

            // Flash effect (Flicker)
            if (this.lightningFlash && this.ambientFlash) {
                const intensity = (Math.random() > 0.3) ? 2.0 : 0.5; // Flicker
                this.lightningFlash.intensity = intensity;
                this.ambientFlash.intensity = intensity * 2; // Global ambient brightness
            }

            if (this.lightningDisplayTimer <= 0) {
                // Done
                this.sceneManager.scene.remove(this.lightningBolt);
                this.lightningBolt.geometry.dispose();
                // Safe dispose
                if (Array.isArray(this.lightningBolt.material)) {
                    this.lightningBolt.material.forEach(m => m.dispose());
                } else {
                    (this.lightningBolt.material as THREE.Material).dispose();
                }
                this.lightningBolt = null;

                // Stop flash
                if (this.lightningFlash) this.lightningFlash.intensity = 0;
                if (this.ambientFlash) this.ambientFlash.intensity = 0;
            }
        }

        if (this.thunderTimer < 0) {
            this.thunderTimer = Math.random() * 4 + 2; // Frequent strikes (2-6s)
            this.spawnLightningBolt(playerPos);
        }
    }

    private spawnLightningBolt(playerPos: THREE.Vector3) {
        // High Altitude start
        const startY = 7000;
        // Random start 
        const startX = playerPos.x + (Math.random() - 0.5) * 4000; // Closer
        const startZ = playerPos.z + (Math.random() - 0.5) * 4000;

        let currentPos = new THREE.Vector3(startX, startY, startZ);

        const pathPoints: THREE.Vector3[] = [currentPos.clone()];

        const segments = 12;
        for (let i = 0; i < segments; i++) {
            const drop = 300 + Math.random() * 400;
            const driftX = (Math.random() - 0.5) * 800;
            const driftZ = (Math.random() - 0.5) * 800;

            const nextY = currentPos.y - drop;
            if (nextY < 100) break; // Go lower to ground

            currentPos.set(currentPos.x + driftX, nextY, currentPos.z + driftZ);
            pathPoints.push(currentPos.clone());
        }

        // Thick Bolt
        const path = new THREE.CatmullRomCurve3(pathPoints);
        const geo = new THREE.TubeGeometry(path, 12, 12, 6, false); // Thick
        const mat = new THREE.MeshBasicMaterial({
            color: 0xaa00ff, // Bright Purple/Violet
            side: THREE.DoubleSide,
            fog: false // Ignore fog to stay bright
        });

        this.lightningBolt = new THREE.Mesh(geo, mat);
        this.sceneManager.scene.add(this.lightningBolt);

        this.lightningDisplayTimer = 0.2;

        console.log("FLASH!");
    }
}

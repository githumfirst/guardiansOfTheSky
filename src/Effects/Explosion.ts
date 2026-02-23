import * as THREE from 'three';
import { SceneManager } from '../SceneManager';

export class Explosion {
    private fireMesh: THREE.Points;
    private smokeMesh: THREE.Points;
    private fireParticles: { velocity: THREE.Vector3 }[] = [];
    private smokeParticles: { velocity: THREE.Vector3 }[] = [];
    private lifeTime: number = 1.2; // Slightly longer for smoke to linger (0.8 -> 1.2)
    private scale: number = 1.0;
    private sceneManager: SceneManager;

    public isDead: boolean = false;

    private createFireTexture(): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1)'); // Hot White
            gradient.addColorStop(0.2, 'rgba(255, 200, 50, 0.8)'); // Yellow
            gradient.addColorStop(0.5, 'rgba(255, 100, 0, 0.3)'); // Orange
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 64, 64);
        }
        return new THREE.CanvasTexture(canvas);
    }

    private createSmokeTexture(): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            // Irregular Billowy Smoke Texture
            const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            gradient.addColorStop(0, 'rgba(100, 100, 100, 0.6)'); // Grey Core
            gradient.addColorStop(0.4, 'rgba(40, 40, 40, 0.4)'); // Darker edge
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 64, 64);

            // Add some "blobs" to make it look billowy
            for (let i = 0; i < 3; i++) {
                const bx = 32 + (Math.random() - 0.5) * 20;
                const by = 32 + (Math.random() - 0.5) * 20;
                const br = 10 + Math.random() * 15;
                const g2 = ctx.createRadialGradient(bx, by, 0, bx, by, br);
                g2.addColorStop(0, 'rgba(60, 60, 60, 0.3)');
                g2.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = g2;
                ctx.beginPath();
                ctx.arc(bx, by, br, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        return new THREE.CanvasTexture(canvas);
    }

    constructor(sceneManager: SceneManager, position: THREE.Vector3, scale: number = 1.0) {
        this.sceneManager = sceneManager;
        this.scale = scale;

        // --- Fire Core Layer ---
        const fireCount = Math.round(150 * (0.3 + 0.7 * scale));
        const fireGeo = new THREE.BufferGeometry();
        const firePos: number[] = [];
        const fireColors: number[] = [];
        const whiteColor = new THREE.Color(1, 1, 0.9);

        for (let i = 0; i < fireCount; i++) {
            firePos.push(position.x, position.y, position.z);
            fireColors.push(whiteColor.r, whiteColor.g, whiteColor.b);

            const speed = (20 + Math.random() * 60) * scale;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            this.fireParticles.push({
                velocity: new THREE.Vector3(
                    speed * Math.sin(phi) * Math.cos(theta),
                    speed * Math.sin(phi) * Math.sin(theta),
                    speed * Math.cos(phi)
                )
            });
        }

        fireGeo.setAttribute('position', new THREE.Float32BufferAttribute(firePos, 3));
        fireGeo.setAttribute('color', new THREE.Float32BufferAttribute(fireColors, 3));

        const fireMat = new THREE.PointsMaterial({
            size: 12.0 * scale,
            vertexColors: true,
            map: this.createFireTexture(),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.fireMesh = new THREE.Points(fireGeo, fireMat);
        this.sceneManager.scene.add(this.fireMesh);

        // --- Smoke Volume Layer ---
        const smokeCount = Math.round(100 * (0.3 + 0.7 * scale));
        const smokeGeo = new THREE.BufferGeometry();
        const smokePos: number[] = [];
        const smokeColors: number[] = [];
        const smokeInitialColor = new THREE.Color(0.2, 0.1, 0.05); // Dark brownish reddish

        for (let i = 0; i < smokeCount; i++) {
            smokePos.push(
                position.x + (Math.random() - 0.5) * 5 * scale,
                position.y + (Math.random() - 0.5) * 5 * scale,
                position.z + (Math.random() - 0.5) * 5 * scale
            );
            smokeColors.push(smokeInitialColor.r, smokeInitialColor.g, smokeInitialColor.b);

            const speed = (5 + Math.random() * 15) * scale;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            this.smokeParticles.push({
                velocity: new THREE.Vector3(
                    speed * Math.sin(phi) * Math.cos(theta),
                    speed * Math.sin(phi) * Math.sin(theta),
                    speed * Math.cos(phi)
                )
            });
        }

        smokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(smokePos, 3));
        smokeGeo.setAttribute('color', new THREE.Float32BufferAttribute(smokeColors, 3));

        const smokeMat = new THREE.PointsMaterial({
            size: 30.0 * scale, // Billowy
            vertexColors: true,
            map: this.createSmokeTexture(),
            transparent: true,
            blending: THREE.NormalBlending,
            depthWrite: false,
            opacity: 0.8
        });

        this.smokeMesh = new THREE.Points(smokeGeo, smokeMat);
        this.sceneManager.scene.add(this.smokeMesh);
    }

    public update(dt: number) {
        const totalDuration = 1.2;
        this.lifeTime -= dt;
        if (this.lifeTime <= 0) {
            this.isDead = true;
            return;
        }

        const progress = 1.0 - (this.lifeTime / totalDuration);

        // Update Fire
        const fPosArr = this.fireMesh.geometry.attributes.position.array as Float32Array;
        const fColArr = this.fireMesh.geometry.attributes.color.array as Float32Array;
        for (let i = 0; i < this.fireParticles.length; i++) {
            const v = this.fireParticles[i].velocity;
            fPosArr[i * 3] += v.x * dt;
            fPosArr[i * 3 + 1] += v.y * dt;
            fPosArr[i * 3 + 2] += v.z * dt;
            v.multiplyScalar(0.8); // Drag

            // Color transition
            if (progress < 0.2) {
                fColArr[i * 3] = 1; fColArr[i * 3 + 1] = 1; fColArr[i * 3 + 2] = 0.8;
            } else {
                const p = (progress - 0.2) / 0.8;
                fColArr[i * 3] = 1.0;
                fColArr[i * 3 + 1] = Math.max(0, 0.6 * (1 - p));
                fColArr[i * 3 + 2] = 0;
            }
        }
        this.fireMesh.geometry.attributes.position.needsUpdate = true;
        this.fireMesh.geometry.attributes.color.needsUpdate = true;
        (this.fireMesh.material as THREE.PointsMaterial).opacity = Math.max(0, 1.0 - progress * 2);
        (this.fireMesh.material as THREE.PointsMaterial).size += 15 * this.scale * dt;

        // Update Smoke
        const sPosArr = this.smokeMesh.geometry.attributes.position.array as Float32Array;
        const sColArr = this.smokeMesh.geometry.attributes.color.array as Float32Array;
        for (let i = 0; i < this.smokeParticles.length; i++) {
            const v = this.smokeParticles[i].velocity;
            sPosArr[i * 3] += v.x * dt;
            sPosArr[i * 3 + 1] += v.y * dt + 4.0 * this.scale * dt; // Rise up
            sPosArr[i * 3 + 2] += v.z * dt;
            v.multiplyScalar(0.95); // Less drag for smoke

            // Color transition (Reddish dark -> Dark Grey -> Black)
            const p = progress;
            if (p < 0.4) {
                const shift = p / 0.4;
                sColArr[i * 3] = 0.2 + 0.3 * shift; // Glow slightly at start
                sColArr[i * 3 + 1] = 0.1 * (1 - shift);
                sColArr[i * 3 + 2] = 0.05 * (1 - shift);
            } else {
                const shift = (p - 0.4) / 0.6;
                const grey = 0.5 * (1 - shift);
                sColArr[i * 3] = grey;
                sColArr[i * 3 + 1] = grey;
                sColArr[i * 3 + 2] = grey;
            }
        }
        this.smokeMesh.geometry.attributes.position.needsUpdate = true;
        this.smokeMesh.geometry.attributes.color.needsUpdate = true;
        (this.smokeMesh.material as THREE.PointsMaterial).opacity = Math.max(0, 0.8 * (1.0 - progress));
        (this.smokeMesh.material as THREE.PointsMaterial).size += 40 * this.scale * dt; // Rapid expansion
    }

    public dispose() {
        this.sceneManager.scene.remove(this.fireMesh);
        this.sceneManager.scene.remove(this.smokeMesh);
        this.fireMesh.geometry.dispose();
        (this.fireMesh.material as THREE.Material).dispose();
        this.smokeMesh.geometry.dispose();
        (this.smokeMesh.material as THREE.Material).dispose();
    }
}

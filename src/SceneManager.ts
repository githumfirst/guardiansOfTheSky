import * as THREE from 'three';
import type { GameManager } from './GameManager';

export class SceneManager {
    public scene: THREE.Scene;
    public camera: THREE.PerspectiveCamera;
    public renderer: THREE.WebGLRenderer;
    private gameManager: GameManager;

    // Explosion Visuals
    private explosions: any[] = [];
    private speedLines: THREE.LineSegments | null = null;

    constructor(gameManager: GameManager) {
        this.gameManager = gameManager;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        // Distance Fog: Push back to see distant enemies (Start 1000, End 3000)
        this.scene.fog = new THREE.Fog(0x87CEEB, 1000, 3000);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 20000);
        this.camera.position.set(0, 5, 10);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        // Performance: Cap resolution on mobile to ~1080p (DPR 2.0 is typical for 1080p density)
        // Desktop remains at native resolution (DPR window.devicePixelRatio)
        const dpr = this.gameManager.isMobile ? Math.min(window.devicePixelRatio, 2.0) : window.devicePixelRatio;
        this.renderer.setPixelRatio(dpr);

        // Performance: Disable shadows on mobile
        this.renderer.shadowMap.enabled = !this.gameManager.isMobile;
        document.getElementById('app')!.appendChild(this.renderer.domElement);

        this.setupLights();
        this.setupSpeedLines();

        window.addEventListener('resize', () => this.onWindowResize(), false);
    }

    private setupLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(50, 100, 50);
        // Performance: Disable shadows on mobile
        dirLight.castShadow = !this.gameManager.isMobile;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        this.scene.add(dirLight);
    }

    private onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        // Ensure pixel ratio remains optimized after resize
        const dpr = this.gameManager.isMobile ? Math.min(window.devicePixelRatio, 2.0) : window.devicePixelRatio;
        this.renderer.setPixelRatio(dpr);
    }



    public addExplosion(explosion: any) {
        this.explosions.push(explosion);
    }

    private setupSpeedLines() {
        const lineCount = 100;
        const positions = new Float32Array(lineCount * 2 * 3);
        const geometry = new THREE.BufferGeometry();

        for (let i = 0; i < lineCount; i++) {
            const r = 5 + Math.random() * 20;
            const theta = Math.random() * Math.PI * 2;
            const x = Math.cos(theta) * r;
            const y = Math.sin(theta) * r;
            const zStart = -Math.random() * 100;
            const zEnd = zStart - (10 + Math.random() * 20);

            positions[i * 6] = x;
            positions[i * 6 + 1] = y;
            positions[i * 6 + 2] = zStart;

            positions[i * 6 + 3] = x;
            positions[i * 6 + 4] = y;
            positions[i * 6 + 5] = zEnd;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0
        });

        this.speedLines = new THREE.LineSegments(geometry, material);
        this.camera.add(this.speedLines); // Attach to camera
        this.scene.add(this.camera);
    }

    public update(dt: number, target?: THREE.Object3D, currentSpeedKmh: number = 0) {
        // Update Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const exp = this.explosions[i];
            exp.update(dt);
            if (exp.isDead) {
                exp.dispose();
                this.explosions.splice(i, 1);
            }
        }

        if (target) {
            // 1. Dynamic FOV: Increase FOV as speed increases for sense of speed
            // Base 75, Max 95 (at 800 km/h)
            const baseFOV = 75;
            const maxFOV = 95;
            const speedFactor = Math.min(1.0, currentSpeedKmh / 800);
            const targetFOV = baseFOV + (maxFOV - baseFOV) * speedFactor;

            // Smoothly interpolate FOV
            this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, 0.1);
            this.camera.updateProjectionMatrix();

            // 2. Speed Lines: Fade in when > 400 km/h
            if (this.speedLines) {
                const lineOpacity = Math.max(0, (currentSpeedKmh - 400) / 400); // 0 at 400, 1.0 at 800
                (this.speedLines.material as THREE.LineBasicMaterial).opacity = lineOpacity;
                this.speedLines.visible = lineOpacity > 0;

                // Jitter speed lines for "flying past" effect
                this.speedLines.position.z = (Date.now() % 100) / 100 * 5;
            }

            // Third person camera offset
            const offset = new THREE.Vector3(0, 5, 10);
            offset.applyQuaternion(target.quaternion);

            const cameraPos = target.position.clone().add(offset);
            // Fix: Use a much faster lerp (or instant) to prevent the camera from lagging behind at high speeds.
            // User reported the plane gets "too small" (distance increases) when speeding up.
            // Increasing lerp factor from 0.1 to 0.8 keeps it tight.
            this.camera.position.lerp(cameraPos, 0.8);

            // Look slightly above the target to lower the plane on screen
            // Offset Y + 5.0
            const lookTarget = target.position.clone().add(new THREE.Vector3(0, 5, 0).applyQuaternion(target.quaternion));
            this.camera.lookAt(lookTarget);
        }
        this.renderer.render(this.scene, this.camera);
    }
}

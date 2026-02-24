import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { GameManager } from './GameManager';

export class SceneManager {
    public scene: THREE.Scene;
    public camera: THREE.PerspectiveCamera;
    public renderer: THREE.WebGLRenderer;
    private gameManager: GameManager;

    // Post-processing
    private composer: EffectComposer | null = null;
    private fxaaPass: ShaderPass | null = null;

    // Adaptive Resolution
    private currentDPR: number = 1.0;
    private frameTimes: number[] = [];
    private lastDPRUpdate: number = 0;

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

        this.renderer = new THREE.WebGLRenderer({
            antialias: !this.gameManager.isMobile, // Use native MSAA on desktop, FXAA on mobile
            precision: this.gameManager.isMobile ? 'mediump' : 'highp', // Lower precision on mobile
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        // Performance: Unlock native DPR on mobile, but start conservatively if device is slow
        this.currentDPR = window.devicePixelRatio || 1.0;
        if (this.gameManager.isMobile && this.currentDPR > 2) this.currentDPR = 2; // Cap initial mobile DPR to 2.0
        this.renderer.setPixelRatio(this.currentDPR);

        // Setup Post-processing for Mobile (FXAA)
        if (this.gameManager.isMobile) {
            this.setupPostProcessing();
        }

        // Performance: Disable shadows on mobile
        this.renderer.shadowMap.enabled = !this.gameManager.isMobile;
        document.getElementById('app')!.appendChild(this.renderer.domElement);

        this.setupLights();
        this.setupSpeedLines();

        window.addEventListener('resize', () => this.onWindowResize(), false);
    }

    private setupPostProcessing() {
        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.fxaaPass = new ShaderPass(FXAAShader);
        this.updateFXAAResolution();
        this.composer.addPass(this.fxaaPass);
    }

    private updateFXAAResolution() {
        if (!this.fxaaPass) return;
        const pixelRatio = this.renderer.getPixelRatio();
        this.fxaaPass.material.uniforms['resolution'].value.x = 1 / (window.innerWidth * pixelRatio);
        this.fxaaPass.material.uniforms['resolution'].value.y = 1 / (window.innerHeight * pixelRatio);
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
        if (this.composer) {
            this.composer.setSize(window.innerWidth, window.innerHeight);
            this.updateFXAAResolution();
        }
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
        // Update Adaptive Resolution on Mobile
        if (this.gameManager.isMobile) {
            this.updateAdaptiveDPR(dt);
        }

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
            const baseFOV = 75;
            const maxFOV = 95;
            const speedFactor = Math.min(1.0, currentSpeedKmh / 800);
            const targetFOV = baseFOV + (maxFOV - baseFOV) * speedFactor;

            this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, 0.1);
            this.camera.updateProjectionMatrix();

            // 2. Speed Lines: Fade in when > 200 km/h
            if (this.speedLines) {
                const lineOpacity = Math.max(0, (currentSpeedKmh - 200) / 600);
                (this.speedLines.material as THREE.LineBasicMaterial).opacity = lineOpacity;
                this.speedLines.visible = lineOpacity > 0;
                this.speedLines.position.z = (Date.now() % 100) / 100 * 5;
            }

            const offset = new THREE.Vector3(0, 5, 10);
            offset.applyQuaternion(target.quaternion);

            const cameraPos = target.position.clone().add(offset);
            this.camera.position.lerp(cameraPos, 0.8);

            const lookTarget = target.position.clone().add(new THREE.Vector3(0, 5, 0).applyQuaternion(target.quaternion));
            this.camera.lookAt(lookTarget);
        }

        if (this.composer) {
            this.composer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    private updateAdaptiveDPR(dt: number) {
        this.frameTimes.push(dt);
        if (this.frameTimes.length > 60) this.frameTimes.shift();

        const now = performance.now();
        // Check performance every 2 seconds
        if (now - this.lastDPRUpdate > 2000 && this.frameTimes.length >= 60) {
            const avgFrameTime = this.frameTimes.reduce((a, b) => a + b) / this.frameTimes.length;

            // If avg frame time > 40ms (below 25fps), lower DPR
            if (avgFrameTime > 0.040 && this.currentDPR > 0.5) {
                this.currentDPR = Math.max(0.5, this.currentDPR - 0.25);
                this.renderer.setPixelRatio(this.currentDPR);
                if (this.composer) this.updateFXAAResolution();
                this.lastDPRUpdate = now;
                console.log(`Performance low. Adjusting DPR to: ${this.currentDPR}`);
            }
            // If avg frame time < 20ms (above 50fps), potentially increase DPR up to native
            else if (avgFrameTime < 0.020 && this.currentDPR < window.devicePixelRatio) {
                const targetDPR = Math.min(window.devicePixelRatio, this.currentDPR + 0.25);
                if (targetDPR !== this.currentDPR) {
                    this.currentDPR = targetDPR;
                    this.renderer.setPixelRatio(this.currentDPR);
                    if (this.composer) this.updateFXAAResolution();
                    this.lastDPRUpdate = now;
                    console.log(`Performance stable. Raising DPR to: ${this.currentDPR}`);
                }
            }
        }
    }
}

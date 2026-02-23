import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneManager } from '../SceneManager';
import { PhysicsWorld } from '../Physics/PhysicsWorld';
import { Explosion } from '../Effects/Explosion';

export class Bullet {
    public mesh: THREE.Mesh;
    public body: CANNON.Body;
    private sceneManager: SceneManager;
    private physicsWorld: PhysicsWorld;
    public isDead: boolean = false;
    private lifeTime: number = 3.0; // Seconds (Increased from 2.0)
    public owner: any = null; // Entity that fired the missile

    private target: any = null; // Enemy type
    private aimPoint: THREE.Vector3 | null = null;

    public static audioCtx: AudioContext | null = null;
    private static launchBuffer: AudioBuffer | null = null;
    private static explosionBuffer: AudioBuffer | null = null;

    public static async preload() {
        if (!Bullet.audioCtx) {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContext) return;
            Bullet.audioCtx = new AudioContext();
        }

        const ctx = Bullet.audioCtx;

        if (!Bullet.launchBuffer) {
            try {
                // Fetch from the public folder (root path in built app)
                const response = await fetch('./bullet.mp3');
                const arrayBuffer = await response.arrayBuffer();
                Bullet.launchBuffer = await ctx.decodeAudioData(arrayBuffer);
                console.log("Bullet sound preloaded!");
            } catch (e) {
                console.error("Failed to preload bullet.mp3:", e);
            }

            try {
                const response = await fetch('./crash.mp3');
                const arrayBuffer = await response.arrayBuffer();
                Bullet.explosionBuffer = await ctx.decodeAudioData(arrayBuffer);
                console.log("Explosion sound preloaded!");
            } catch (e) {
                console.error("Failed to preload crash.mp3:", e);
            }
        }
    }

    public static resumeContext() {
        if (Bullet.audioCtx && Bullet.audioCtx.state === 'suspended') {
            Bullet.audioCtx.resume();
        }
    }

    constructor(sceneManager: SceneManager, physicsWorld: PhysicsWorld, position: THREE.Vector3, quaternion: THREE.Quaternion, target: any = null, aimPoint: THREE.Vector3 | null = null) {
        this.sceneManager = sceneManager;
        this.physicsWorld = physicsWorld;
        this.target = target;
        this.aimPoint = aimPoint;

        // Visual
        // Cylinder for missile shape, rotated to point -Z
        const geometry = new THREE.CylinderGeometry(0.3, 0.3, 4.5, 8);
        geometry.rotateX(-Math.PI / 2); // Point forward
        const material = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(position);
        this.mesh.quaternion.copy(quaternion);
        this.sceneManager.scene.add(this.mesh);

        // Physics
        const shape = new CANNON.Sphere(0.2); // Keep sphere collision for simplicity
        this.body = new CANNON.Body({
            mass: 0.1,
            position: new CANNON.Vec3(position.x, position.y, position.z),
            shape: shape,
            linearDamping: 0,
            fixedRotation: true // Don't tumble
        });
        this.body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);

        this.body.collisionFilterGroup = 2; // Bullet group
        this.body.collisionFilterMask = 4; // Enemy group
        this.physicsWorld.world.addBody(this.body);

        this.playLaunchSound();
    }

    private playLaunchSound() {
        if (!Bullet.audioCtx || !Bullet.launchBuffer) return;
        const ctx = Bullet.audioCtx;
        const source = ctx.createBufferSource();
        source.buffer = Bullet.launchBuffer;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.5, ctx.currentTime);
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
    }

    public static playExplosionSound(volume: number = 0.6) {
        if (!Bullet.audioCtx || !Bullet.explosionBuffer) return;
        const ctx = Bullet.audioCtx;
        const source = ctx.createBufferSource();
        source.buffer = Bullet.explosionBuffer;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
    }

    public update(dt: number) {
        this.lifeTime -= dt;
        if (this.lifeTime <= 0) {
            this.explode(0.1); // Small pop on timeout
            return;
        }

        const speed = 500; // Increased from 300
        let desiredDir: THREE.Vector3 | null = null;

        // Homing Logic
        if (this.target && !this.target.isDead) {
            // Steer towards target
            const targetPos = this.target.mesh.position.clone();
            const myPos = this.mesh.position.clone();
            desiredDir = targetPos.sub(myPos).normalize();
        } else if (this.aimPoint) {
            // Fly towards aim point
            const myPos = this.mesh.position.clone();
            const dist = myPos.distanceTo(this.aimPoint);
            // If we are very close to aim point (and it's ground), explode? 
            // Or just fly through if it's air. 
            // Let's explode if close to aim point, assuming aim point is "impact point"
            if (dist < 10) {
                this.explode(0.1); // Small pop on ground/aim impact
                return;
            }
            desiredDir = this.aimPoint.clone().sub(myPos).normalize();
        }

        if (desiredDir) {
            // Current direction (from quaternion)
            const currentDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);

            // Determine if it's a tail-chase (target is flying away from us)
            let turnRateMultiplier = 1.0;
            if (this.target && this.target.mesh) {
                // Direction the target is moving
                const targetForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.target.mesh.quaternion);
                // Direction from missile to target
                const toTarget = desiredDir.clone();
                // If they align, it's a tail-chase
                if (targetForward.dot(toTarget) > 0.5) {
                    turnRateMultiplier = 2.0; // 2x Buff for tail-chase
                }
            }

            // Interpolate direction (Turning capability)
            const baseTurnRate = 10.0;
            const turnRate = baseTurnRate * turnRateMultiplier * dt;
            const newDir = currentDir.lerp(desiredDir, turnRate).normalize();

            // Update Quaternion to look at new direction
            const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), newDir, new THREE.Vector3(0, 1, 0));
            this.mesh.quaternion.setFromRotationMatrix(m);

            // Sync physics rotation
            this.body.quaternion.set(this.mesh.quaternion.x, this.mesh.quaternion.y, this.mesh.quaternion.z, this.mesh.quaternion.w);
        }

        // Apply Velocity in facing direction
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
        this.body.velocity.set(direction.x * speed, direction.y * speed, direction.z * speed);

        // Visual Scaling (Fake "Flying Away" perspective)
        const progress = 1.0 - (this.lifeTime / 2.0); // 0 to 1
        const scale = 1.0 - progress * 0.8; // 1.0 -> 0.2
        this.mesh.scale.set(scale, scale, scale);

        // Sync mesh
        this.mesh.position.copy(this.body.position as any);
    }

    public explode(scale: number = 1.0) {
        if (this.isDead) return;
        this.isDead = true;

        // Spawn Explosion
        const exp = new Explosion(this.sceneManager, this.mesh.position.clone(), scale);
        this.sceneManager.addExplosion(exp);
    }

    public dispose() {
        this.sceneManager.scene.remove(this.mesh);
        this.physicsWorld.world.removeBody(this.body);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}

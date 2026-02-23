import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneManager } from '../SceneManager';
import { PhysicsWorld } from '../Physics/PhysicsWorld';

export class Enemy {
    public mesh: THREE.Group;
    public body: CANNON.Body;
    private sceneManager: SceneManager;
    private physicsWorld: PhysicsWorld;
    public isDead: boolean = false;
    private afterburners: THREE.Mesh[] = [];
    private visualRoll: number = 0; // Track visual bank angle separately

    constructor(sceneManager: SceneManager, physicsWorld: PhysicsWorld, position: CANNON.Vec3, playerPos?: THREE.Vector3, initialQuat?: THREE.Quaternion) {
        this.sceneManager = sceneManager;
        this.physicsWorld = physicsWorld;

        this.mesh = new THREE.Group();

        // Visual (Simple Enemy Plane) - Scaled ~8x (25m size)
        const fuselage = new THREE.Mesh(
            new THREE.ConeGeometry(4, 20, 16), // Radius 4, Height 20
            new THREE.MeshPhongMaterial({ color: 0xcc0000 }) // Brighter Red
        );
        // Rotate -PI/2 to point nose to -Z (Forward)
        fuselage.rotation.x = -Math.PI / 2;
        this.mesh.add(fuselage);

        // 1. Front (Main) Wings - Wide and Forward
        const mainWings = new THREE.Mesh(
            new THREE.BoxGeometry(32, 0.8, 6), // Width 32 (Wide), Height 0.8, Depth 6
            new THREE.MeshPhongMaterial({ color: 0x880000 }) // Darker Red
        );
        mainWings.position.set(0, 0, -3); // Forward (-Z)
        this.mesh.add(mainWings);

        // 2. Tail Wings - Small and Rear
        const tailWings = new THREE.Mesh(
            new THREE.BoxGeometry(12, 0.8, 4), // Width 12 (Small), Height 0.8, Depth 4
            new THREE.MeshPhongMaterial({ color: 0x880000 })
        );
        tailWings.position.set(0, 0, 8); // Back (+Z)
        this.mesh.add(tailWings);

        // 3. Vertical Fin (Tail Rudder) - Definitive "UP" and "BACK"
        const fin = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 6, 4),
            new THREE.MeshPhongMaterial({ color: 0xcc0000 })
        );
        fin.position.set(0, 3, 8); // Top rear
        this.mesh.add(fin);

        // 4. Cockpit - Definitive "FRONT"
        const cockpit = new THREE.Mesh(
            new THREE.SphereGeometry(1, 16, 8),
            new THREE.MeshPhongMaterial({ color: 0x111111 })
        );
        cockpit.scale.set(0.8, 0.5, 1.5);
        cockpit.position.set(0, 1.5, -6); // Near nose
        this.mesh.add(cockpit);

        // 5. Afterburners (Engine Nozzles)
        this.afterburners = [];
        const nozzleGeo = new THREE.TorusGeometry(1.2, 0.4, 8, 16);
        const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
        const plumeGeo = new THREE.ConeGeometry(1.0, 6, 16);
        plumeGeo.translate(0, -3, 0);

        const enginePos = [
            new THREE.Vector3(-2.5, 0, 10),
            new THREE.Vector3(2.5, 0, 10)
        ];

        enginePos.forEach(pos => {
            const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
            nozzle.position.copy(pos);
            nozzle.rotation.x = Math.PI / 2;
            this.mesh.add(nozzle);

            const plume = new THREE.Mesh(
                plumeGeo,
                new THREE.MeshBasicMaterial({
                    color: 0xff0000,
                    transparent: true,
                    opacity: 0.8,
                    blending: THREE.AdditiveBlending
                })
            );
            plume.position.copy(pos);
            plume.rotation.x = -Math.PI / 2; // Point backward (+Z)
            this.mesh.add(plume);
            this.afterburners.push(plume);
        });

        this.sceneManager.scene.add(this.mesh);

        // Physics - Scaled to match player mass and feel
        const shape = new CANNON.Box(new CANNON.Vec3(12, 2, 8));
        this.body = new CANNON.Body({
            mass: 1, // Match player mass for consistent physics response
            position: position,
            linearDamping: 0.1, // Low damping for "air glide" feel
            angularDamping: 0.9, // High damping to prevent spinning wildly
            collisionFilterGroup: 4, // Enemy
            collisionFilterMask: 2 | 1 // Bullet | Player | World
        });
        this.body.addShape(shape);
        (this.body as any).entity = this; // Store reference for identification in collisions

        // Environment Collision Listener
        this.body.addEventListener('collide', (e: any) => {
            if (this.isDead) return;
            // If we hit anything that isn't the player or a bullet, it's environment/ground
            const other = e.body;
            if (other.collisionFilterGroup === 1) { // World
                this.isDead = true; // Flag for GameManager cleanup
                console.log("Enemy hit environment!");
            }
        });

        this.physicsWorld.world.addBody(this.body);

        // INITIAL ORIENTATION: Face the player OR use provided rotation (Tail-Chase)
        const myPos = new THREE.Vector3(position.x, position.y, position.z);
        let finalQuat: THREE.Quaternion;

        if (initialQuat) {
            finalQuat = initialQuat.clone();
        } else if (playerPos) {
            const targetMatrix = new THREE.Matrix4();
            targetMatrix.lookAt(myPos, playerPos, new THREE.Vector3(0, 1, 0));
            finalQuat = new THREE.Quaternion().setFromRotationMatrix(targetMatrix);
        } else {
            finalQuat = new THREE.Quaternion();
        }

        this.body.quaternion.set(finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w);
        this.mesh.quaternion.copy(finalQuat);
        this.mesh.position.copy(myPos);
    }

    public isAggressive: boolean = false;
    private fireTimer: number = 0;
    private readonly fireInterval: number = 6.0; // Increased from 3.0 to halve aggressiveness

    public update(dt: number, playerPos: THREE.Vector3, playerVelocity: CANNON.Vec3) {
        if (this.isDead) return;

        const myPos = new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z);
        const myQuat = new THREE.Quaternion(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);

        // --- 1. TARGETING & AI BRAIN ---
        let targetPoint = playerPos.clone();
        const dist = myPos.distanceTo(playerPos);

        if (this.isAggressive) {
            // Predict player position (Intercept logic)
            const speedMs = this.body.velocity.length();
            const predictionTime = Math.min(2.0, dist / (speedMs + 1));
            targetPoint.add(new THREE.Vector3(playerVelocity.x, playerVelocity.y, playerVelocity.z).multiplyScalar(predictionTime));

            // Collision Avoidance - Toned down significantly 
            if (dist < 200) {
                const toTarget = targetPoint.clone().sub(myPos).normalize();
                const up = new THREE.Vector3(0, 1, 0);
                const sideDir = new THREE.Vector3().crossVectors(toTarget, up).normalize();
                targetPoint.add(sideDir.multiplyScalar(20));
            }

            // Firing Logic
            this.fireTimer += dt;
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(myQuat);
            const toPlayer = playerPos.clone().sub(myPos).normalize();
            if (this.fireTimer > this.fireInterval && dist < 800 && forward.dot(toPlayer) > 0.8) {
                this.fireTimer = 0;
                this.shootMissile();
            }
        }

        // --- 2. KINEMATIC STEERING (No-Spin Fix) ---
        // Calculate the target rotation (Look At Target)
        const targetMatrix = new THREE.Matrix4();
        // Nose is -Z, Up is +Y (World Up)
        targetMatrix.lookAt(myPos, targetPoint, new THREE.Vector3(0, 1, 0));
        const targetQuat = new THREE.Quaternion().setFromRotationMatrix(targetMatrix);

        // Smoothly rotate the body quaternion towards the target (Realistic Dogfight Turn - 2x Radius)
        const angleToTarget = myQuat.angleTo(targetQuat);
        const maxTurnRate = this.isAggressive ? 0.6 : 0.3; // Half of 1.2/0.6 to DOUBLE turn radius
        const turnStep = maxTurnRate * dt;
        const slerpFactor = angleToTarget > 0.001 ? Math.min(1.0, turnStep / angleToTarget) : 1.0;

        myQuat.slerp(targetQuat, slerpFactor);
        this.body.quaternion.set(myQuat.x, myQuat.y, myQuat.z, myQuat.w);

        // Kill any physical angular velocity to prevent spinning
        this.body.angularVelocity.set(0, 0, 0);

        // --- 3. FLIGHT PHYSICS & VELOCITY LOCK ---
        const currentSpeed = this.body.velocity.length();
        const speedLimit = this.isAggressive ? 142 : 72; // Aggressive: ~511km/h, Cruise: ~259km/h (Reduced ~100km/h)
        let newSpeed = Math.min(speedLimit, currentSpeed + 5 * dt); // Further lower acceleration (10 -> 5)
        if (currentSpeed > speedLimit) newSpeed = THREE.MathUtils.lerp(currentSpeed, speedLimit, 2.0 * dt);

        // Hard-lock velocity to forward direction (Eliminates Crabbing)
        const forwardDir = new THREE.Vector3(0, 0, -1).applyQuaternion(myQuat);
        this.body.velocity.set(forwardDir.x * newSpeed, forwardDir.y * newSpeed, forwardDir.z * newSpeed);

        // --- 4. VISUALS: Banking & Sync ---
        this.mesh.position.set(this.body.position.x, this.body.position.y, this.body.position.z);

        // Calculate lateral turn magnitude for visual banking
        const localTarget = targetPoint.clone().sub(myPos).applyQuaternion(myQuat.clone().invert());
        const targetVisualRoll = Math.max(-0.8, Math.min(0.8, -localTarget.x / 50));
        this.visualRoll = THREE.MathUtils.lerp(this.visualRoll, targetVisualRoll, 4.0 * dt);

        // Apply visual roll to the mesh
        const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.visualRoll);
        this.mesh.quaternion.copy(myQuat).multiply(rollQuat);

        // --- 5. VISUALS: Afterburners (Red + Yellow) ---
        if (this.afterburners.length > 0) {
            this.afterburners.forEach(plume => {
                // Flicker effect
                const flicker = 0.8 + Math.random() * 0.4;
                plume.scale.set(flicker, flicker, flicker * 1.5);

                // Alternate between Red and Yellow for "Red + Yellow" look
                // We use a faster oscillator for color blending
                const colorSwitch = Math.sin(Date.now() * 0.05) > 0;
                (plume.material as THREE.MeshBasicMaterial).color.setHex(colorSwitch ? 0xff0000 : 0xffaa00);
                (plume.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.random() * 0.4;
            });
        }

        // Limit Altitude
        if (this.body.position.y > 1000) {
            this.body.position.y = 1000;
            this.body.velocity.y = Math.min(0, this.body.velocity.y);
        }
    }

    private shootMissile() {
        // This will be called via a callback to GameManager to avoid circular dependency
        // or we can use a custom event. For simplicity, let's use a callback provided by GameManager.
        if ((this as any).onShoot) {
            // Offset spawn point to nose
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
            const spawnPos = new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z).add(forward.multiplyScalar(10));
            (this as any).onShoot(spawnPos, this.mesh.quaternion.clone());
        }
    }

    public dispose() {
        this.sceneManager.scene.remove(this.mesh);
        this.physicsWorld.world.removeBody(this.body);
        // Dispose geometries/materials
    }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneManager } from '../SceneManager';
import { PhysicsWorld } from '../Physics/PhysicsWorld';
import { Bullet } from './Bullet';
import { Explosion } from '../Effects/Explosion';

export class Player {
    public mesh: THREE.Group;
    public body: CANNON.Body;
    private afterburners: THREE.Mesh[] = [];
    private sceneManager: SceneManager;
    private physicsWorld: PhysicsWorld;

    public speed: number = 0;
    private maxSpeed: number = 222.2; // 800 km/h in m/s
    public targetCruiseSpeed: number = 0; // Speed to maintain when no input
    public isTryingToTakeoffTooSlow: boolean = false; // Emergency warning flag
    public onDie: (() => void) | null = null; // Callback for GameManager
    public hasTakenOff: boolean = false; // Tracks if the player has successfully lifted off

    private turnSpeed: number = 2.0;
    private pitchSpeed: number = 1.5;

    public isBoosting: boolean = false; // Added property

    public input = {
        up: false,
        down: false,
        left: false,
        right: false,
        throttleUp: false,
        throttleDown: false,
        shoot: false
    };

    // HP System
    public maxHp: number = 10;
    public currentHp: number = 10;
    public isDead: boolean = false;
    private invulnerableTime: number = 0; // IFrames
    private idleTimer: number = 0;

    private static afterburnerBuffer: AudioBuffer | null = null;
    private afterburnerSource: AudioBufferSourceNode | null = null;
    private afterburnerGain: GainNode | null = null;
    private isAfterburnerSoundPlaying: boolean = false;

    public static async preloadSound() {
        if (!Bullet.audioCtx) {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContext) return;
            Bullet.audioCtx = new AudioContext();
        }

        if (!Player.afterburnerBuffer) {
            try {
                // The file is in the public folder
                const response = await fetch('/afterburner.mp3');
                const arrayBuffer = await response.arrayBuffer();
                Player.afterburnerBuffer = await Bullet.audioCtx.decodeAudioData(arrayBuffer);
                console.log("Afterburner sound preloaded!");
            } catch (e) {
                console.error("Failed to preload afterburner.mp3:", e);
            }
        }
    }

    public static resumeContext() {
        if (Bullet.audioCtx && Bullet.audioCtx.state === 'suspended') {
            Bullet.audioCtx.resume();
        }
    }

    constructor(sceneManager: SceneManager, physicsWorld: PhysicsWorld) {
        this.sceneManager = sceneManager;
        this.physicsWorld = physicsWorld;

        this.mesh = new THREE.Group();

        // Build Low-Poly Fighter Jet
        const jetModel = this.createLowPolyJet();
        this.mesh.add(jetModel);

        this.sceneManager.scene.add(this.mesh);

        // Physics Body (Compound Shape)
        this.body = new CANNON.Body({
            mass: 1, // Dynamic
            position: new CANNON.Vec3(100, 2, 500), // Runway Start (Corrected for ChunkSize 200)
            // OLD: linearDamping: 0.9, angularDamping: 0.9 (Too high, caused shaking)
            // NEW: Lower damping for smoother movement, requires less force
            linearDamping: 0.1,
            angularDamping: 0.5,
            fixedRotation: false,
            collisionFilterGroup: 2, // Player
            collisionFilterMask: 4 | 1 // Enemy | Ground?
        });

        // 1. Fuselage (Body) - Scaled 2/3
        // Old: 0.6, 0.6, 2.5 -> New: 0.4, 0.4, 1.6
        const fuselageShape = new CANNON.Box(new CANNON.Vec3(0.4, 0.4, 1.6));
        this.body.addShape(fuselageShape, new CANNON.Vec3(0, 0, 0));

        // 2. Wings (Left/Right) - Scaled 2/3
        // Old: 2.5, 0.2, 1.0 -> New: 1.6, 0.13, 0.6
        const wingShape = new CANNON.Box(new CANNON.Vec3(1.6, 0.13, 0.6));
        this.body.addShape(wingShape, new CANNON.Vec3(0, 0, 0.3)); // Scaled offset

        this.physicsWorld.world.addBody(this.body);

        // Collision Handler (Visuals Only, Damage handled by GameManager for consistency)
        this.body.addEventListener('collide', () => {
            if (this.isDead || this.invulnerableTime > 0) return;
            // Screen shake or other visual impacts can be added here
        });

        this.setupInput();
        this.updateHPUI();
    }

    public takeDamage(amount: number) {
        this.currentHp -= amount;
        this.invulnerableTime = 0.5; // 0.5s invulnerability

        // Shake / Flash?

        if (this.currentHp < 0) {
            this.die();
        }

        this.updateHPUI();
    }

    private updateHPUI() {
        const fill = document.getElementById('hp-fill');
        const val = document.getElementById('hp-val');

        // Clamp 0-10
        const displayHp = Math.max(0, this.currentHp);

        if (val) val.textContent = displayHp.toString();
        if (fill) {
            const pct = (displayHp / this.maxHp) * 100;
            fill.style.width = `${pct}%`;

            // Color shift logic could go here
            if (pct < 30) fill.style.background = '#ff0000';
            else fill.style.background = 'linear-gradient(90deg, #ff0000, #ff8800, #00ff00)';
        }
    }

    private die() {
        if (this.isDead) return;
        this.isDead = true;
        this.currentHp = -1;
        this.mesh.visible = false; // Hide ship

        // Explosion Effect
        this.createExplosion();

        // --- ADDED: DETAILED EXPLOSION EFFECT ---
        // Spawn a large Explosion (scale 2.0) using the Explosion class
        const exp = new Explosion(this.sceneManager, this.mesh.position.clone(), 2.0);
        this.sceneManager.addExplosion(exp);

        // Notify GameManager (Immediate for sound effects)
        if (this.onDie) this.onDie();
        this.stopAfterburnerSound(); // Ensure sound stops on death
    }

    public reset() {
        this.currentHp = this.maxHp;
        this.isDead = false;
        this.mesh.visible = true;
        this.invulnerableTime = 2.0; // Grace period on restart
        this.updateHPUI();
        this.targetCruiseSpeed = 0;
        this.hasTakenOff = false;
        this.stopAfterburnerSound(); // Ensure sound stops on reset
    }

    private createExplosion() {
        // Simple Particle Explosion
        const particleCount = 50;
        const geo = new THREE.BufferGeometry();
        const positions = [];
        const velocities: number[] = [];

        for (let i = 0; i < particleCount; i++) {
            positions.push(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
            velocities.push(
                (Math.random() - 0.5) * 50,
                (Math.random() - 0.5) * 50,
                (Math.random() - 0.5) * 50
            );
        }

        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0xff5500,
            size: 2,
            sizeAttenuation: true
        });

        const particles = new THREE.Points(geo, mat);
        this.sceneManager.scene.add(particles);

        // Animate particles (Quick hack: attach to SceneManager loop needed?
        // Or just let them sit? They need to move.
        // I'll add a temporary "Explosion Object" to scene manager update list if possible.
        // For now, static explosion is boring.
        // I will rely on the fact that the game loop continues.

        const animateExplosion = () => {
            const posAttr = particles.geometry.attributes.position;
            for (let i = 0; i < particleCount; i++) {
                posAttr.setXYZ(i,
                    posAttr.getX(i) + velocities[i * 3] * 0.1,
                    posAttr.getY(i) + velocities[i * 3 + 1] * 0.1,
                    posAttr.getZ(i) + velocities[i * 3 + 2] * 0.1
                );
            }
            posAttr.needsUpdate = true;
            (particles.material as THREE.PointsMaterial).opacity -= 0.02;
            if ((particles.material as THREE.PointsMaterial).opacity > 0) {
                requestAnimationFrame(animateExplosion);
            } else {
                this.sceneManager.scene.remove(particles);
            }
        };
        animateExplosion();

        console.log("BOOM!");
    }

    /** Texture for the fire plume: hot white core -> yellow -> red -> transparent tip */
    private createPlumeTex(): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        // Vertical gradient: bright white-yellow at base -> orange -> red -> transparent at tip
        const g = ctx.createLinearGradient(0, 128, 0, 0); // Base (bottom) -> Tip (top)
        g.addColorStop(0, 'rgba(255, 255, 220, 1.0)'); // White-Yellow hot core
        g.addColorStop(0.15, 'rgba(255, 200, 0,   1.0)'); // Yellow
        g.addColorStop(0.4, 'rgba(255, 80,  0,   0.9)'); // Orange-Red
        g.addColorStop(0.75, 'rgba(200, 20,  0,   0.6)'); // Deep Red
        g.addColorStop(1.0, 'rgba(80,  0,   0,   0.0)'); // Transparent tip
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 128);
        return new THREE.CanvasTexture(canvas);
    }

    private createLowPolyJet(): THREE.Group {
        const model = new THREE.Group();
        const bodyColor = 0x888888; // Lighter Gray Stealth Hull
        const cockpitColor = 0x111111; // Dark Glass
        // const engineColor = 0x111111; // Dark Exhausts (Unused in this vers)

        // 1. Blended Wing Body (Main Hull + Wings Integrated)
        const shape = new THREE.Shape();
        shape.moveTo(0, -2.5); // Nose
        shape.lineTo(1.5, -0.5); // Leading Edge to Body Joint
        shape.lineTo(4.5, 2.0); // Wing Tip
        shape.lineTo(2.5, 2.8); // Trailing Edge Output
        shape.lineTo(0, 2.0); // Center Tail
        shape.lineTo(-2.5, 2.8);
        shape.lineTo(-4.5, 2.0);
        shape.lineTo(-1.5, -0.5);
        shape.lineTo(0, -2.5); // Close at Nose

        const extrudeSettings = {
            steps: 2,
            depth: 0.4,
            bevelEnabled: true,
            bevelThickness: 0.1,
            bevelSize: 0.1,
            bevelSegments: 2
        };

        const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        const body = new THREE.Mesh(geom, new THREE.MeshPhongMaterial({
            color: bodyColor,
            specular: 0x111111,
            shininess: 10
        }));

        body.rotation.x = Math.PI / 2; // Flat
        body.position.set(0, 0, 0);
        model.add(body);

        // 2. Cockpit Bulge (Low Profile, Blended)
        const cockpitGeo = new THREE.SphereGeometry(0.5, 16, 8);
        cockpitGeo.scale(0.8, 0.4, 1.2);
        const cockpit = new THREE.Mesh(cockpitGeo, new THREE.MeshPhongMaterial({ color: cockpitColor }));
        cockpit.position.set(0, 0.3, -1.0); // Near Nose
        model.add(cockpit);

        // 3. Engine Humps (3 Engines)
        const humpGeo = new THREE.CapsuleGeometry(0.3, 1.0, 4, 8);
        const humpMat = new THREE.MeshPhongMaterial({ color: bodyColor });

        // Center Hump
        const centerHump = new THREE.Mesh(humpGeo, humpMat);
        centerHump.rotation.x = Math.PI / 2;
        centerHump.position.set(0, 0.2, 1.5);
        model.add(centerHump);

        // Left Hump
        const leftHump = new THREE.Mesh(humpGeo, humpMat);
        leftHump.rotation.x = Math.PI / 2;
        leftHump.position.set(-1.2, 0.2, 1.8);
        model.add(leftHump);

        // Right Hump
        const rightHump = new THREE.Mesh(humpGeo, humpMat);
        rightHump.rotation.x = Math.PI / 2;
        rightHump.position.set(1.2, 0.2, 1.8);
        model.add(rightHump);

        // Scale Model (1.2 * 2/3 = 0.8)
        model.scale.set(0.8, 0.8, 0.8);


        // 4. AFTERBURNERS: Realistic nozzle ring + fire plume
        const plumeTex = this.createPlumeTex();

        // Engine nozzle exit positions (back of the 3 engine humps)
        const enginePositions = [
            new THREE.Vector3(0, 0.2, 2.05),  // Center
            new THREE.Vector3(-1.2, 0.2, 2.25),  // Left
            new THREE.Vector3(1.2, 0.2, 2.25),  // Right
        ];

        this.afterburners = [];

        enginePositions.forEach(ePos => {
            // --- A) Nozzle Ring (Torus) ---
            const ringGeo = new THREE.TorusGeometry(0.28, 0.06, 8, 24);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xff8800,
                transparent: true,
                opacity: 0.95,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.copy(ePos);
            ring.rotation.x = Math.PI / 2; // Face backward
            model.add(ring);
            // Track ring in afterburners (index % 2 == 0 -> ring)
            this.afterburners.push(ring);

            // --- B) Fire Plume (Cone pointing backward) ---
            const coneGeo = new THREE.ConeGeometry(0.28, 2.5, 16, 1, true);
            coneGeo.translate(0, -1.25, 0); // Shift so base is at origin
            const coneMat = new THREE.MeshBasicMaterial({
                map: plumeTex,
                color: 0xffffff,
                transparent: true,
                opacity: 0.95,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const cone = new THREE.Mesh(coneGeo, coneMat);
            cone.position.copy(ePos);
            cone.rotation.x = -Math.PI / 2; // Base at nozzle, tip points backward (+Z)
            model.add(cone);
            // Track cone in afterburners (index % 2 == 1 -> cone)
            this.afterburners.push(cone);
        });

        return model;
    }


    private setupInput() {
        window.addEventListener('keydown', (e) => this.onKey(e, true));
        window.addEventListener('keyup', (e) => this.onKey(e, false));
    }

    private onKey(e: KeyboardEvent, pressed: boolean) {
        switch (e.code) {
            case 'ArrowUp': this.input.up = pressed; break;
            case 'ArrowDown': this.input.down = pressed; break;
            case 'ArrowLeft': this.input.left = pressed; break;
            case 'ArrowRight': this.input.right = pressed; break;
            case 'ShiftLeft': this.input.throttleUp = pressed; break;
            case 'ControlLeft': this.input.throttleDown = pressed; break;
            case 'Space': this.input.shoot = pressed; break;
        }
    }

    private startAfterburnerSound() {
        if (!Bullet.audioCtx || !Player.afterburnerBuffer) return;
        if (this.isAfterburnerSoundPlaying) {
            // If already playing, ensure gain is at max or fading in
            if (this.afterburnerGain) {
                this.afterburnerGain.gain.cancelScheduledValues(Bullet.audioCtx.currentTime);
                this.afterburnerGain.gain.linearRampToValueAtTime(0.5, Bullet.audioCtx.currentTime + 0.1); // Quick fade in
            }
            return;
        }

        this.afterburnerSource = Bullet.audioCtx.createBufferSource();
        this.afterburnerSource.buffer = Player.afterburnerBuffer;
        this.afterburnerSource.loop = true;

        this.afterburnerGain = Bullet.audioCtx.createGain();
        this.afterburnerGain.gain.setValueAtTime(0.001, Bullet.audioCtx.currentTime); // Start very low
        this.afterburnerGain.gain.linearRampToValueAtTime(0.5, Bullet.audioCtx.currentTime + 0.5); // Fade in over 0.5s

        this.afterburnerSource.connect(this.afterburnerGain);
        this.afterburnerGain.connect(Bullet.audioCtx.destination);

        this.afterburnerSource.start(0);
        this.isAfterburnerSoundPlaying = true;
    }

    private stopAfterburnerSound() {
        if (!this.isAfterburnerSoundPlaying || !this.afterburnerGain || !Bullet.audioCtx) return;

        // Fade out over 0.5 seconds
        const ctx = Bullet.audioCtx;
        this.afterburnerGain.gain.cancelScheduledValues(ctx.currentTime);
        this.afterburnerGain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.5);

        // Capture source and gain to stop them later
        const source = this.afterburnerSource;
        const gain = this.afterburnerGain;

        if (source) {
            source.stop(ctx.currentTime + 0.5);
            source.onended = () => {
                source.disconnect();
                gain.disconnect();
            };
        }

        this.afterburnerSource = null;
        this.afterburnerGain = null;
        this.isAfterburnerSoundPlaying = false;
    }

    public update(dt: number) {
        if (this.isDead) return; // Stop Updating if dead

        if (this.invulnerableTime > 0) {
            this.invulnerableTime -= dt;
        }

        // Flight Physics (Local Axis Control)

        // 1. Calculate Local Inputs
        // BLOCK PITCH DOWN ON GROUND: Ignore "Up Arrow" if altitude is near zero to prevent clipping issues.
        const isAtGroundLevel = !this.hasTakenOff && this.body.position.y < 2.2;
        const effectiveUp = isAtGroundLevel ? false : this.input.up;
        const pitchInput = (this.input.down ? 1 : 0) - (effectiveUp ? 1 : 0);
        const yawInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0);
        const rollInput = yawInput * 0.5;

        // Idle detection
        const hasInput = this.input.up || this.input.down || this.input.left || this.input.right;
        if (hasInput) {
            this.idleTimer = 0;
        } else {
            this.idleTimer += dt;
        }

        // 2. Get Local Axes in World Space
        const localX = new CANNON.Vec3(1, 0, 0); // Pitch Axis (Right Wing)
        const localY = new CANNON.Vec3(0, 1, 0); // Yaw Axis (Up)
        const localZ = new CANNON.Vec3(0, 0, 1); // Roll Axis (Tail)

        const worldX = this.body.quaternion.vmult(localX);
        const worldY = this.body.quaternion.vmult(localY);
        const worldZ = this.body.quaternion.vmult(localZ);

        // 3. Apply Controls
        if (pitchInput !== 0) {
            const torque = worldX.scale(pitchInput * this.pitchSpeed * dt);
            this.body.angularVelocity.vadd(torque, this.body.angularVelocity);
        }

        if (yawInput !== 0) {
            const yawTorque = worldY.scale(yawInput * this.turnSpeed * dt);
            const rollTorque = worldZ.scale(rollInput * this.turnSpeed * dt);

            this.body.angularVelocity.vadd(yawTorque, this.body.angularVelocity);
            this.body.angularVelocity.vadd(rollTorque, this.body.angularVelocity); // Bank
        }

        // 4. Stability / Auto-Correction
        const worldUp = new CANNON.Vec3(0, 1, 0);
        const upDot = worldY.dot(worldUp);

        if (pitchInput === 0 && yawInput === 0) {
            // Dampen rotation
            this.body.angularVelocity.scale(0.95, this.body.angularVelocity);

            // Auto-Level / Auto-Recovery logic
            if (this.idleTimer > 0.5 && upDot < 0.5) {
                // Plane is inverted or sideways and idle. Apply strong rolling torque.
                // We rotate around the local Z axis (worldZ) to flip upright without changing heading.
                // We check worldX.y to decide which way to roll for efficiency.
                const rollDir = worldX.dot(worldUp) > 0 ? -1 : 1;
                const rollCorrection = worldZ.scale(rollDir * 8.0 * dt);
                this.body.angularVelocity.vadd(rollCorrection, this.body.angularVelocity);
            } else {
                // Standard Auto-Level: Align Plane's Up Vector with World Up
                const correctionAxis = worldY.cross(worldUp);
                const correctionForce = 1.0 * dt;
                this.body.angularVelocity.vadd(correctionAxis.scale(correctionForce), this.body.angularVelocity);
            }
        }

        // --- ARCADE FLIGHT PHYSICS: VELOCITY ALIGNMENT ---
        // Force the plane to fly in the direction it is facing (Pseudo-Aerodynamics)
        // Without this, low damping causes "drifting" (Space ship style)
        // With this, the plane "bites" the air and turns sharply.

        // 1. Get Forward Direction (Local -Z in World Space)
        const forward = new CANNON.Vec3(0, 0, -1);
        const worldForward = this.body.quaternion.vmult(forward);

        // 2. Get Speed Scalar
        const currentSpeed = this.body.velocity.length();

        // 3. Create Target Velocity (Forward * Speed)
        const targetVelocity = worldForward.scale(currentSpeed);

        // 4. Blend (Lerp) to Target Velocity
        // Higher factor = tighter turning (less drift), more "on rails"
        // Lower factor = more drift/slide
        const stabilityFactor = 2.0 * dt; // Tweak this for feel

        this.body.velocity.lerp(targetVelocity, stabilityFactor, this.body.velocity);


        // Altitude compensation removed to restore natural drop during turns


        // Altitude compensation removed to restore natural drop during turns


        // --- Speed Control Logic (Velocity Based) ---
        // 1. Get current physical speed
        const currentSpeedMs = this.body.velocity.length();
        const currentSpeedKmh = currentSpeedMs * 3.6;

        // 2. Calculate Drag Force (to counteract damping)
        // Damping 0.1 means drag force is approx 0.1 * speed * mass
        const dragForce = currentSpeedMs * this.body.linearDamping * this.body.mass;

        let thrustInfo = 0;

        if (this.input.throttleUp) {
            // Accelerate: Overcome drag + Add acceleration
            // Boosted: 16 -> 24 (+50% increase from previous boost)
            thrustInfo = dragForce + 24;
            this.targetCruiseSpeed = currentSpeedMs; // Update cruise target while accelerating
            this.startAfterburnerSound();
        } else if (this.input.throttleDown) {
            // Brake: Less than drag (or negative)
            // Force 10 -> 50 for much stronger deceleration (Airbrakes)
            thrustInfo = dragForce - 50;
            this.targetCruiseSpeed = currentSpeedMs; // Update cruise target while braking
            this.stopAfterburnerSound();
        } else {
            // Maintain Current Speed (Cruise Control)
            this.stopAfterburnerSound();
            // If we are on runway and haven't moved yet, don't try to cruise
            if (currentSpeedKmh < 1 && !this.input.throttleUp) {
                this.targetCruiseSpeed = 0;
                thrustInfo = 0;
            } else {
                // Apply exactly enough force to counter drag + small correction to fix error
                const speedError = this.targetCruiseSpeed - currentSpeedMs;
                thrustInfo = dragForce + speedError * 2.0; // K=2.0 for smooth correction
            }
        }

        // Apply Thrust
        // Don't apply negative thrust if stopped (no reverse)
        if (currentSpeedMs < 0.1 && thrustInfo < 0) thrustInfo = 0;

        this.body.applyLocalForce(new CANNON.Vec3(0, 0, -thrustInfo), new CANNON.Vec3(0, 0, 0));

        // 3. Strict Speed Clamping (Max 800 km/h)
        if (currentSpeedMs > this.maxSpeed) {
            // Scale velocity vector safely
            const scale = this.maxSpeed / currentSpeedMs;
            this.body.velocity.scale(scale, this.body.velocity);
        }

        // Sync local speed variable for UI/Logic
        this.speed = currentSpeedMs;

        // Update boosting state (Threshold 600 km/h?)
        this.isBoosting = currentSpeedKmh > 600 && this.input.throttleUp;

        // Move Forward
        // If on ground (speed < takeoffSpeed), ensure we stay on ground unless pitching up?
        // Actually, simple logic:
        // Identify Takeoff Speed ~ 250 km/h (69.44 m/s)
        const takeoffSpeed = 69.44;
        const isOnGround = this.body.position.y <= 2.5; // Close to ground (2.0 is limit)

        this.isTryingToTakeoffTooSlow = false;

        if (isOnGround) {
            // Taxiing Logic
            // Only allow Pitch UP if speed > takeoffSpeed
            if (this.speed < takeoffSpeed) {
                if (this.input.down) {
                    this.isTryingToTakeoffTooSlow = true;
                }

                // Force Pitch to 0 (Level)
                this.body.angularVelocity.x = 0;
                this.body.angularVelocity.z = 0;

                // Strictly clamp height
                this.body.position.y = 2.0;
                this.body.velocity.y = 0;
            }
        }

        // Apply Thrust applied above in Speed Control Logic

        // --- STALL MECHANIC ---
        // If speed < 100 km/h and airborne, drop altitude rapidly
        // currentSpeedMs/Kmh already calculated above


        if (currentSpeedKmh < 100 && this.body.position.y > 5) {
            // Apply strong downward force or direct velocity modification to simulate stall/crash
            // Gravity is -9.82. Let's add extra downward pull.
            // A direct velocity modification feels more "rapid" and uncontrollable.
            this.body.velocity.y -= 20 * dt; // Accelerate downwards quickly

            // Optional: Slight random rotation to simulate loss of control? 
            // User only asked for altitude drop. Sticking to that.
        }

        // Sync Mesh
        this.mesh.position.copy(this.body.position as any);
        this.mesh.quaternion.copy(this.body.quaternion as any);

        // Constrain height or CRASH
        if (this.body.position.y < 2.01) {
            // Check for crash condition: Moving but at 0m altitude (meaning hitting the ground)
            // isOnGround check in update() uses 2.5. 
            // Here at exactly 2.0-2.1 we are touching the earth.
            if (!this.isDead && this.body.position.y <= 2.1) {
                // Determine if this is a "Safe Taxi" or a "Crash"
                // Only crash if we have already taken off and are moving fast.
                // On the runway before takeoff, hasTakenOff is false.
                if (this.hasTakenOff && this.speed > 27.7) { // > 100 km/h
                    this.die();
                } else {
                    // Safe taxi/land
                    this.body.position.y = 2;
                    this.body.velocity.y = Math.max(0, this.body.velocity.y);
                }
            } else {
                this.body.position.y = 2;
                this.body.velocity.y = Math.max(0, this.body.velocity.y);
            }
        }

        // Max Altitude Limit (1000m)
        if (this.body.position.y > 1000) {
            this.body.position.y = 1000;
            this.body.velocity.y = Math.min(0, this.body.velocity.y); // Stop upward movement
        }


        // Anti-Gravity REMOVED as per user request.
        // Altitude will drop naturally due to PhysicsWorld gravity.

        if (this.afterburners.length > 0) {

            const isBoost = this.input.throttleUp;

            // afterburners array: [ring0, cone0, ring1, cone1, ring2, cone2]
            // Even indices = nozzle rings, Odd indices = fire plumes (cones)
            this.afterburners.forEach((mesh, i) => {
                const isRing = (i % 2 === 0);
                const flicker = 1.0 + (Math.random() - 0.5) * 0.2;

                if (isBoost) {
                    // --- BOOST MODE ---
                    if (isRing) {
                        // Ring: brighter white-yellow glow
                        mesh.scale.lerp(new THREE.Vector3(2.5, 2.5, 2.5), dt * 10);
                        (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xffffaa);
                        (mesh.material as THREE.MeshBasicMaterial).opacity = 1.0;
                    } else {
                        // Plume cone: long, bright orange-white
                        mesh.scale.lerp(new THREE.Vector3(2.0 * flicker, 4.0 * flicker, 2.0 * flicker), dt * 10);
                        (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
                        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.95;
                    }
                } else {
                    // --- NORMAL MODE ---
                    if (isRing) {
                        // Ring: orange glow
                        mesh.scale.lerp(new THREE.Vector3(1.0, 1.0, 1.0), dt * 8);
                        (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xff6600);
                        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
                    } else {
                        // Plume cone: moderate orange-red flame
                        mesh.scale.lerp(new THREE.Vector3(1.0 * flicker, 1.5 * flicker, 1.0 * flicker), dt * 8);
                        (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xff8800);
                        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
                    }
                }
                mesh.visible = true;
            });
        }
    }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneManager } from '../SceneManager';
import { PhysicsWorld } from '../Physics/PhysicsWorld';

export class CityBuilder {
    private sceneManager: SceneManager;
    private physicsWorld: PhysicsWorld;
    private cityGroup: THREE.Group;

    private chunkSize: number = 200; // Size of one grid
    private renderDistance: number = 6; // Radius of chunks to keep loaded (Reduced from 12 for performance)
    private loadedChunks: Map<string, THREE.Group> = new Map();
    private chunkBodies: Map<string, CANNON.Body[]> = new Map();
    private cityTexture: THREE.Texture | null = null;

    private currentLat: number = 0;
    private currentLon: number = 0;

    constructor(sceneManager: SceneManager, physicsWorld: PhysicsWorld) {
        this.sceneManager = sceneManager;
        this.physicsWorld = physicsWorld;
        this.cityGroup = new THREE.Group();
        this.sceneManager.scene.add(this.cityGroup);
    }

    public generateCity(lat: number, lon: number, startPos?: THREE.Vector3) {
        // Reset everything for new stage
        this.clearCity();
        this.currentLat = lat;
        this.currentLon = lon;

        // Initial Generation
        this.update(startPos || new THREE.Vector3(0, 0, 0));
    }

    public update(playerPos: THREE.Vector3) {
        const playerChunkX = Math.floor(playerPos.x / this.chunkSize);
        const playerChunkZ = Math.floor(playerPos.z / this.chunkSize);

        // Determine chunks that should be loaded
        const chunksNeeded: Set<string> = new Set();

        for (let x = -this.renderDistance; x <= this.renderDistance; x++) {
            for (let z = -this.renderDistance; z <= this.renderDistance; z++) {
                const chunkX = playerChunkX + x;
                const chunkZ = playerChunkZ + z;
                chunksNeeded.add(`${chunkX},${chunkZ}`);

                if (!this.loadedChunks.has(`${chunkX},${chunkZ}`)) {
                    this.loadChunk(chunkX, chunkZ);
                }
            }
        }

        // Unload old chunks
        for (const key of this.loadedChunks.keys()) {
            if (!chunksNeeded.has(key)) {
                this.unloadChunk(key);
            }
        }
    }

    private createCityTexture(): THREE.Texture {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            // 1. Dark Background (City Night)
            ctx.fillStyle = '#050510'; // Very dark blue/black
            ctx.fillRect(0, 0, 512, 512);

            // 2. Glow Effect (Redistributed - Dimmer)
            ctx.shadowBlur = 5; // Reduced blur
            ctx.shadowColor = '#554400'; // Dimmer shadow

            // 3. Random Street Grid
            // Draw random lines to simulate streets
            const drawLine = (x1: number, y1: number, x2: number, y2: number, width: number, color: string) => {
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            };

            // Main Roads (Dimmer Gold/Orange)
            // Was #ffcc00 -> Now #aa8800
            for (let i = 0; i <= 512; i += 128) {
                drawLine(i, 0, i, 512, 4, '#aa8800'); // Vertical
                drawLine(0, i, 512, i, 4, '#aa8800'); // Horizontal
            }

            // Secondary Roads (Dim Blue/White)
            ctx.shadowColor = '#003366';
            for (let i = 0; i <= 512; i += 32) {
                if (i % 128 === 0) continue; // Skip if main road exists
                drawLine(i, 0, i, 512, 1, '#335588'); // Vertical
                drawLine(0, i, 512, i, 1, '#335588'); // Horizontal
            }

            // City Lights (Dots)
            for (let i = 0; i < 50; i++) {
                const x = Math.random() * 512;
                const y = Math.random() * 512;
                const size = 1 + Math.random() * 2;
                ctx.fillStyle = Math.random() > 0.5 ? '#999999' : '#aa8800';
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 16;
        return tex;
    }

    private loadChunk(cx: number, cz: number) {
        const chunkGroup = new THREE.Group();
        const worldX = cx * this.chunkSize;
        const worldZ = cz * this.chunkSize;
        chunkGroup.position.set(worldX, 0, worldZ);
        const chunkKey = `${cx},${cz}`;
        const bodies: CANNON.Body[] = [];

        // Seed
        const seed = (Math.abs((this.currentLat + cx) * 1000) ^ Math.abs((this.currentLon + cz) * 1000));
        const noise = this.pseudoRandomResults(seed); // 0-1

        if (!this.cityTexture) {
            this.cityTexture = this.createCityTexture();
        }

        // Biome Coherence
        const coherentNoise = (Math.sin(cx * 0.3) + Math.cos(cz * 0.3) + 2) / 4;
        let biomeValue = coherentNoise * 0.7 + noise * 0.3;

        // Check if this is the HOME BASE chunk (0,0) or nearby?
        // Let's make 0,0 and 0,1 the Airport.
        // Actually, let's just make one HUGE special chunk logic for (0,0).
        if (cx === 0 && cz === 0) {
            this.buildAirport(chunkGroup, worldX, worldZ, bodies);
            this.loadedChunks.set(`${cx},${cz}`, chunkGroup);
            this.cityGroup.add(chunkGroup);
            this.chunkBodies.set(chunkKey, bodies);
            return;
        }

        // Airport Isolation Logic
        // Radius of 3 chunks around (0,0) -> NO CITY. Force Nature or Water.
        const distFromCenter = Math.sqrt(cx * cx + cz * cz);

        // Clear Runway Path: Clear a strip along Z axis (cz) where X (cx) is near 0.
        // Runway is at cx=0. Clear width of +/- 2 chunks, Length +/- 20 chunks?
        // User wants "Runway end... no buildings".
        const isRunwayPath = Math.abs(cx) <= 1 && Math.abs(cz) < 15;

        const isBufferZone = distFromCenter < 3.5 || isRunwayPath;

        if (isBufferZone) {
            // Force Biome to Nature (Grass/Trees) or Water if noise is super low
            // Let's make it mostly grassy flatland for safe flying near airport.
            // Override biomeValue to force nature or water
            biomeValue = (noise < 0.1) ? 0.0 : 0.75; // Force water if very low noise, else nature
        }

        // Biome Thresholds (Approximate)
        // 0.0 - 0.25: River (Water)
        // 0.25 - 0.55: City (Dense)
        // 0.55 - 0.70: Outskirts (Sparse)
        // 0.70 - 0.85: Nature Buffer (HUGE GAP - 15% of range)
        // 0.85 - 1.0: Mountain (High, Rounded)

        let isWater = false;
        let isMountain = false;
        let isNature = false;

        // Visuals
        if (biomeValue < 0.25) {
            // RIVER / WATER
            isWater = true;
            const waterGeo = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize);
            const waterMat = new THREE.MeshPhongMaterial({
                color: 0x002244,
                shininess: 100,
                specular: 0x4444ff
            });
            const water = new THREE.Mesh(waterGeo, waterMat);
            water.rotation.x = -Math.PI / 2;
            water.position.set(this.chunkSize / 2, -2, this.chunkSize / 2);
            water.receiveShadow = true;
            chunkGroup.add(water);

            if (noise > 0.6) {
                this.createBridge(chunkGroup);
            }

            // ADD VEGETATION ON BANKS (Skip if in Airport Buffer)
            if (!isBufferZone) {
                let random = this.mulberry32(seed);
                for (let t = 0; t < 20; t++) {
                    const side = random() > 0.5 ? 10 : this.chunkSize - 10;
                    const tx = random() > 0.5 ? side : random() * this.chunkSize;
                    const tz = tx === side ? random() * this.chunkSize : side;
                    this.addTree(chunkGroup, tx, tz, random);
                }
            }

        } else if (biomeValue > 0.85) {
            // MOUNTAIN (Complex Ranges with wider bases)
            isMountain = true;
            let random = this.mulberry32(seed);

            // Ground for mountains
            const mountainGround = new THREE.Mesh(
                new THREE.PlaneGeometry(this.chunkSize, this.chunkSize),
                new THREE.MeshPhongMaterial({ color: 0x1a331a })
            );
            mountainGround.rotation.x = -Math.PI / 2;
            mountainGround.position.set(this.chunkSize / 2, -0.05, this.chunkSize / 2);
            chunkGroup.add(mountainGround);

            // Mountain Ground Physics
            const groundBody = new CANNON.Body({
                type: CANNON.Body.STATIC,
                position: new CANNON.Vec3(worldX + this.chunkSize / 2, -0.1, worldZ + this.chunkSize / 2),
                collisionFilterGroup: 1,
                collisionFilterMask: 2 | 4
            });
            groundBody.addShape(new CANNON.Box(new CANNON.Vec3(this.chunkSize / 2, 0.1, this.chunkSize / 2)));
            this.physicsWorld.world.addBody(groundBody);
            bodies.push(groundBody);

            const numPeaks = 4 + Math.floor(random() * 4); // 4-8 peaks
            for (let k = 0; k < numPeaks; k++) {
                const peakH = 180 + random() * 280;
                const peakBase = 80 + random() * 100;
                const peakX = random() * this.chunkSize;
                const peakZ = random() * this.chunkSize;

                // Create a range look by adding overlapping sub-peaks
                const subPeaks = 2 + Math.floor(random() * 3);
                for (let s = 0; s < subPeaks; s++) {
                    const sH = peakH * (0.6 + random() * 0.4);
                    const sB = peakBase * (0.8 + random() * 0.4);
                    const offsetX = (random() - 0.5) * 60;
                    const offsetZ = (random() - 0.5) * 60;

                    const isRounded = random() > 0.5;
                    let geo;
                    if (isRounded) {
                        // Rounded Peak: Scalloped/Low hill look
                        geo = new THREE.SphereGeometry(1, 16, 12);
                    } else {
                        // Sharp Peak: Classic mount
                        geo = new THREE.ConeGeometry(sB, sH, 8);
                    }

                    const mat = new THREE.MeshPhongMaterial({
                        color: random() > 0.5 ? 0x224422 : 0x2d332d,
                        flatShading: true
                    });

                    const mesh = new THREE.Mesh(geo, mat);
                    const localX = peakX + offsetX;
                    const localZ = peakZ + offsetZ;

                    if (isRounded) {
                        mesh.position.set(localX, 0, localZ);
                        mesh.scale.set(sB * 1.5, sH, sB * 1.5);

                        // Physics: Rounded peak as a box for stability
                        // (CANNON doesn't support non-uniform scaling of spheres easily)
                        const body = new CANNON.Body({
                            type: CANNON.Body.STATIC,
                            position: new CANNON.Vec3(worldX + localX, sH / 4, worldZ + localZ),
                            collisionFilterGroup: 1,
                            collisionFilterMask: 2 | 4
                        });
                        body.addShape(new CANNON.Box(new CANNON.Vec3(sB * 0.8, sH / 4, sB * 0.8)));
                        this.physicsWorld.world.addBody(body);
                        bodies.push(body);
                    } else {
                        mesh.position.set(localX, sH / 2, localZ);
                        mesh.scale.set(1.2, 1, 1.2);

                        // Physics: Sharp peak as a Cylinder (radiusTop=0)
                        const body = new CANNON.Body({
                            type: CANNON.Body.STATIC,
                            position: new CANNON.Vec3(worldX + localX, sH / 2, worldZ + localZ),
                            collisionFilterGroup: 1,
                            collisionFilterMask: 2 | 4
                        });
                        const shape = new CANNON.Cylinder(0.01, sB * 1.2, sH, 8);
                        body.addShape(shape);
                        this.physicsWorld.world.addBody(body);
                        bodies.push(body);
                    }
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    chunkGroup.add(mesh);
                }
            }
            // Add some trees at the base of mountains
            for (let t = 0; t < 15; t++) {
                const tx = random() * this.chunkSize;
                const tz = random() * this.chunkSize;
                this.addTree(chunkGroup, tx, tz, random, worldX, worldZ, bodies);
            }

        } else if (isBufferZone || biomeValue > 0.70) {
            // NATURE BUFFER (Green flatland, NO BUILDINGS)
            // 15% of the total noise range is a HUGE gap.
            isNature = true;
            const groundGeo = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize);
            const groundMat = new THREE.MeshPhongMaterial({ color: 0x225522 }); // Dark Green Ground

            const ground = new THREE.Mesh(groundGeo, groundMat);
            ground.rotation.x = -Math.PI / 2;
            ground.position.set(this.chunkSize / 2, -0.1, this.chunkSize / 2);
            ground.receiveShadow = true;
            chunkGroup.add(ground);

            // Maybe add some trees? (Skip if in Airport Buffer)
            if (!isBufferZone) {
                let random = this.mulberry32(seed);
                for (let t = 0; t < 25; t++) {
                    const treeX = random() * this.chunkSize;
                    const treeZ = random() * this.chunkSize;
                    this.addTree(chunkGroup, treeX, treeZ, random, worldX, worldZ, bodies);
                }
            }

            // Nature Ground Physics
            const groundBody = new CANNON.Body({
                type: CANNON.Body.STATIC,
                position: new CANNON.Vec3(worldX + this.chunkSize / 2, -0.1, worldZ + this.chunkSize / 2),
                collisionFilterGroup: 1,
                collisionFilterMask: 2 | 4
            });
            groundBody.addShape(new CANNON.Box(new CANNON.Vec3(this.chunkSize / 2, 0.1, this.chunkSize / 2)));
            this.physicsWorld.world.addBody(groundBody);
            bodies.push(groundBody);

        } else {
            // CITY (Standard Ground)
            const groundGeo = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize);
            const groundMat = new THREE.MeshStandardMaterial({
                map: this.cityTexture,
                emissiveMap: this.cityTexture,
                emissive: 0xffffff,
                emissiveIntensity: 0.3,
                roughness: 0.9,
                metalness: 0.1
            });

            const ground = new THREE.Mesh(groundGeo, groundMat);
            ground.rotation.x = -Math.PI / 2;
            ground.position.set(this.chunkSize / 2, -0.1, this.chunkSize / 2);
            ground.receiveShadow = true;
            chunkGroup.add(ground);

            // City Ground Physics
            const groundBody = new CANNON.Body({
                type: CANNON.Body.STATIC,
                position: new CANNON.Vec3(worldX + this.chunkSize / 2, -0.1, worldZ + this.chunkSize / 2),
                collisionFilterGroup: 1,
                collisionFilterMask: 2 | 4
            });
            groundBody.addShape(new CANNON.Box(new CANNON.Vec3(this.chunkSize / 2, 0.1, this.chunkSize / 2)));
            this.physicsWorld.world.addBody(groundBody);
            bodies.push(groundBody);
        }

        // BUILDINGS (Only in City Biome, NOT in Nature or Mountain)
        if (!isWater && !isMountain && !isNature) {
            let random = this.mulberry32(seed);
            // Further Reduced Building Count
            // Was: 5-13
            // New: 2-6 (Very Sparse)
            const numBuildings = 2 + Math.floor(random() * 4);
            const boxGeo = new THREE.BoxGeometry(1, 1, 1); // Reusable base geo

            for (let i = 0; i < numBuildings; i++) {
                // Decision: Building Type Logic for VARIETY
                const rType = random();

                let w, d, h;
                let color;

                // 1. House / Low-Rise (30%)
                if (rType < 0.3) {
                    w = 10 + random() * 10;
                    d = 10 + random() * 10;
                    h = 10 + random() * 15; // 10-25m
                    color = 0x885533; // Brownish
                }
                // 2. Mega Block (Thick & Short) (20%)
                else if (rType < 0.5) {
                    w = 40 + random() * 30; // Huge base
                    d = 40 + random() * 30;
                    h = 30 + random() * 40; // 30-70m (Reduced from 100-300)
                    color = this.getRandomColor(random);
                }
                // 3. Needle (Thin & Tall) (20%)
                else if (rType < 0.7) {
                    w = 10 + random() * 8; // Thin
                    d = 10 + random() * 8;
                    h = 50 + random() * 40; // 50-90m (Reduced from 400-700)
                    color = this.getRandomColor(random);
                }
                // 4. Standard Skyscraper (30%)
                else {
                    w = 20 + random() * 15;
                    d = 20 + random() * 15;
                    h = 40 + random() * 50; // 40-90m (Reduced from 200-500)
                    color = this.getRandomColor(random);
                }

                // Nature Buffer (Green Belt) Logic:
                // biomeValue range for city is 0.25 - 0.70.
                // Near 0.25 (River) or 0.70 (Nature), we reduce building spawn or height.
                const edgeBuffer = 0.1;
                let densityFactor = 1.0;
                if (biomeValue < 0.25 + edgeBuffer) densityFactor = (biomeValue - 0.25) / edgeBuffer;
                if (biomeValue > 0.70 - edgeBuffer) densityFactor = (0.70 - biomeValue) / edgeBuffer;

                if (random() > densityFactor) {
                    // Spawn a tree cluster instead of a building
                    this.addTree(chunkGroup, random() * this.chunkSize, random() * this.chunkSize, random, worldX, worldZ, bodies);
                    continue;
                }

                h *= (0.5 + 0.5 * densityFactor); // Scale height near edges

                const material = new THREE.MeshPhongMaterial({
                    color: color,
                    flatShading: true
                });
                const mesh = new THREE.Mesh(boxGeo, material);

                // Position
                const x = random() * this.chunkSize;
                const z = random() * this.chunkSize;

                // Scale
                mesh.position.set(x, h / 2, z);
                mesh.scale.set(w, h, d);

                mesh.castShadow = true;
                mesh.receiveShadow = true;
                chunkGroup.add(mesh);

                // Building Physics
                const body = new CANNON.Body({
                    type: CANNON.Body.STATIC,
                    position: new CANNON.Vec3(worldX + x, h / 2, worldZ + z),
                    collisionFilterGroup: 1,
                    collisionFilterMask: 2 | 4
                });
                body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
                this.physicsWorld.world.addBody(body);
                bodies.push(body);
            }
        }

        this.loadedChunks.set(chunkKey, chunkGroup);
        this.chunkBodies.set(chunkKey, bodies);
        this.cityGroup.add(chunkGroup);
    }

    private buildAirport(chunkGroup: THREE.Group, worldX: number, worldZ: number, bodies: CANNON.Body[]) {
        // Build a special Airport Chunk at (0,0)

        // 1. Ground (Asphalt / Concrete)
        const groundGeo = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize);
        const groundMat = new THREE.MeshPhongMaterial({ color: 0x333333 });

        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(this.chunkSize / 2, 0.1, this.chunkSize / 2); // Slight offset
        ground.receiveShadow = true;
        chunkGroup.add(ground);

        // Ground Physics
        const groundBody = new CANNON.Body({
            type: CANNON.Body.STATIC,
            position: new CANNON.Vec3(worldX + this.chunkSize / 2, 0.1, worldZ + this.chunkSize / 2),
            collisionFilterGroup: 1,
            collisionFilterMask: 2 | 4
        });
        groundBody.addShape(new CANNON.Box(new CANNON.Vec3(this.chunkSize / 2, 0.1, this.chunkSize / 2)));
        this.physicsWorld.world.addBody(groundBody);
        bodies.push(groundBody);

        // 2. Runway
        // Long strip down the middle (Z-axis). 
        // Width: 40m, Length: 800m (extends across chunk?)
        // Let's make it cover most of the chunk Z at X=Center.
        // ChunkSize is 1000.

        const runwayGeo = new THREE.PlaneGeometry(60, 900);
        const runwayMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa }); // Light Gray Asphalt

        const runway = new THREE.Mesh(runwayGeo, runwayMat);
        runway.rotation.x = -Math.PI / 2;
        runway.position.set(this.chunkSize / 2, 0.2, this.chunkSize / 2); // Center of chunk
        runway.receiveShadow = true;
        chunkGroup.add(runway);

        // Markings (White Stripes)
        // Dashed line down the center
        for (let z = -400; z < 400; z += 60) {
            const stripe = new THREE.Mesh(
                new THREE.PlaneGeometry(2, 30),
                new THREE.MeshBasicMaterial({ color: 0xffffff })
            );
            stripe.rotation.x = -Math.PI / 2;
            stripe.position.set(this.chunkSize / 2, 0.25, this.chunkSize / 2 + z);
            chunkGroup.add(stripe);
        }

        // 3. Control Tower (Based on reference image)
        // Tall white cylindrical tower with blue glass top.
        // Located to the side of the runway. e.g. Left side (X < Center).

        const towerX = this.chunkSize / 2 - 150;
        const towerZ = this.chunkSize / 2;

        const towerGroup = new THREE.Group();
        towerGroup.position.set(towerX, 0, towerZ);

        // Base (Boxy)
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(60, 40, 60),
            new THREE.MeshPhongMaterial({ color: 0xdddddd }) // Light Grey
        );
        base.position.y = 20;
        towerGroup.add(base);

        // Shaft (Cylindrical logic / Tapered)
        // White
        const shaftH = 120;
        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(15, 20, shaftH, 16),
            new THREE.MeshPhongMaterial({ color: 0xffffff })
        );
        shaft.position.y = 40 + shaftH / 2;
        towerGroup.add(shaft);

        // Top Control Room (Wider, Glass)
        const topH = 20;
        const topRoom = new THREE.Mesh(
            new THREE.CylinderGeometry(25, 15, topH, 16), // Inverted taper or bowl? Reference looks like a distinctive head.
            new THREE.MeshPhongMaterial({
                color: 0x88ccff,
                shininess: 90,
                opacity: 0.7,
                transparent: true
            })
        );
        topRoom.position.y = 40 + shaftH + topH / 2;
        towerGroup.add(topRoom);

        // Roof
        const roof = new THREE.Mesh(
            new THREE.CylinderGeometry(28, 28, 2, 16),
            new THREE.MeshPhongMaterial({ color: 0x555555 })
        );
        roof.position.y = 40 + shaftH + topH + 1;
        towerGroup.add(roof);

        chunkGroup.add(towerGroup);

        // Physics for Tower
        const towerBody = new CANNON.Body({
            type: CANNON.Body.STATIC,
            position: new CANNON.Vec3(worldX + towerX, 90, worldZ + towerZ),
            collisionFilterGroup: 1, // World
            collisionFilterMask: 2 | 4 // Player | Enemy
        });
        towerBody.addShape(new CANNON.Box(new CANNON.Vec3(30, 90, 30)));
        this.physicsWorld.world.addBody(towerBody);
        bodies.push(towerBody);

        // Add some lights? 
        const light = new THREE.PointLight(0xffaa00, 1, 300);
        light.position.set(towerX, 180, towerZ);
        chunkGroup.add(light);
    }

    private createBridge(parent: THREE.Group) {
        // Simple Beam Bridge
        const bridgeGeo = new THREE.BoxGeometry(40, 2, this.chunkSize);
        const bridgeMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
        const bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
        bridge.position.set(this.chunkSize / 2, 10, this.chunkSize / 2);

        // Pylons
        const pylonGeo = new THREE.BoxGeometry(4, 20, 4);
        const pylon1 = new THREE.Mesh(pylonGeo, bridgeMat);
        pylon1.position.set(this.chunkSize / 2, -10, 20);
        const pylon2 = new THREE.Mesh(pylonGeo, bridgeMat);
        pylon2.position.set(this.chunkSize / 2, -10, this.chunkSize - 20);

        bridge.add(pylon1);
        bridge.add(pylon2);

        parent.add(bridge);
    }

    private pseudoRandomResults(a: number): number {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    private unloadChunk(key: string) {
        const chunk = this.loadedChunks.get(key);
        if (chunk) {
            this.cityGroup.remove(chunk);
            // Dispose geometries/materials
            chunk.traverse((obj) => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => m.dispose());
                    } else {
                        (obj.material as THREE.Material).dispose();
                    }
                }
            });
            this.loadedChunks.delete(key);
        }

        const bodies = this.chunkBodies.get(key);
        if (bodies) {
            bodies.forEach(b => this.physicsWorld.world.removeBody(b));
            this.chunkBodies.delete(key);
        }
    }

    private clearCity() {
        this.loadedChunks.forEach((_, key) => this.unloadChunk(key));
        this.loadedChunks.clear();
        this.chunkBodies.clear();
    }

    private getRandomColor(random: () => number): number {
        const colors = [0xaaaaaa, 0xcccccc, 0x888888, 0x555555, 0x777799, 0x999977, 0x444466];
        return colors[Math.floor(random() * colors.length)];
    }

    private addTree(parent: THREE.Group, x: number, z: number, random: () => number, worldX: number = 0, worldZ: number = 0, bodies?: CANNON.Body[]) {
        const h = 8 + random() * 10;
        const trunkH = h * 0.2;
        const foliageH = h * 0.8;

        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.5, 0.8, trunkH),
            new THREE.MeshPhongMaterial({ color: 0x442200 })
        );
        trunk.position.y = trunkH / 2;
        group.add(trunk);

        const foliage = new THREE.Mesh(
            new THREE.ConeGeometry(3, foliageH, 6),
            new THREE.MeshPhongMaterial({ color: 0x004400, flatShading: true })
        );
        foliage.position.y = trunkH + foliageH / 2;
        group.add(foliage);

        parent.add(group);

        // Physics
        if (bodies) {
            const body = new CANNON.Body({
                type: CANNON.Body.STATIC,
                position: new CANNON.Vec3(worldX + x, trunkH / 2, worldZ + z),
                collisionFilterGroup: 1,
                collisionFilterMask: 2 | 4
            });
            body.addShape(new CANNON.Box(new CANNON.Vec3(1, trunkH / 2, 1))); // Trunk collision
            this.physicsWorld.world.addBody(body);
            bodies.push(body);
        }
    }

    private mulberry32(a: number) {
        return function () {
            var t = a += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }
}

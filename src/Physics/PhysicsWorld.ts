import * as CANNON from 'cannon-es';

export class PhysicsWorld {
    public world: CANNON.World;

    constructor() {
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0); // Gravity

        // Default material
        const defaultMaterial = new CANNON.Material('default');
        const defaultContactMaterial = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
            friction: 0.0, // Low friction for air?
            restitution: 0.3,
        });
        this.world.addContactMaterial(defaultContactMaterial);
    }

    public update(dt: number) {
        this.world.step(1 / 60, dt, 3);
    }
}

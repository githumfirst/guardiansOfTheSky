import './style.css'
import { GameManager } from './GameManager';

const gameManager = new GameManager();

// Start loop
function animate() {
    requestAnimationFrame(animate);
    gameManager.update();
}

animate();

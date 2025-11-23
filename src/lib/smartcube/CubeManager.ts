
export interface SavedCube {
    id: string;
    name: string;
    mac: string | null;
    isDefault: boolean;
    type: 'GAN' | 'Moyu';
}

const CUBES_STORAGE_KEY = 'saved-cubes';

export class CubeManager {
    private cubes: SavedCube[] = [];

    constructor() {
        this.loadCubes();
    }

    private loadCubes() {
        try {
            const stored = localStorage.getItem(CUBES_STORAGE_KEY);
            if (stored) {
                this.cubes = JSON.parse(stored);
            } else {
                this.cubes = [];
            }
        } catch (e) {
            console.error('Error loading cubes:', e);
            this.cubes = [];
        }
    }

    private saveCubes() {
        try {
            localStorage.setItem(CUBES_STORAGE_KEY, JSON.stringify(this.cubes));
        } catch (e) {
            console.error('Error saving cubes:', e);
        }
    }

    getCubes(): SavedCube[] {
        return this.cubes;
    }

    addCube(name: string, mac: string | null, type: 'GAN' | 'Moyu', isDefault: boolean = false): SavedCube {
        if (isDefault) {
            this.cubes.forEach(c => c.isDefault = false);
        }

        const newCube: SavedCube = {
            id: Date.now().toString(),
            name,
            mac,
            isDefault: isDefault || this.cubes.length === 0,
            type
        };

        this.cubes.push(newCube);
        this.saveCubes();
        return newCube;
    }

    updateCube(id: string, updates: Partial<SavedCube>) {
        const cube = this.cubes.find(c => c.id === id);
        if (cube) {
            if (updates.isDefault) {
                this.cubes.forEach(c => c.isDefault = false);
            }
            Object.assign(cube, updates);
            this.saveCubes();
        }
    }

    deleteCube(id: string) {
        this.cubes = this.cubes.filter(c => c.id !== id);
        if (this.cubes.length > 0 && !this.cubes.some(c => c.isDefault)) {
            this.cubes[0].isDefault = true;
        }
        this.saveCubes();
    }

    getDefaultCube(): SavedCube | undefined {
        return this.cubes.find(c => c.isDefault) || this.cubes[0];
    }

    getCube(id: string): SavedCube | undefined {
        return this.cubes.find(c => c.id === id);
    }
}

export const cubeManager = new CubeManager();

export class HistoryManager {
  constructor(storage, network, onStateChanged) {
    this.storage = storage;
    this.network = network;
    this.onStateChanged = onStateChanged; // callback to trigger rerender

    this.undoStack = [];
    this.redoStack = [];
  }

  push(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > 120) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.updateUI();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.updateUI();
  }

  updateUI() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.disabled = this.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) return;

    let inverseOp = null;

    switch (action.type) {
      case 'draw': {
        const idx = this.storage.strokes.findIndex(s => s.id === action.id);
        if (idx >= 0) {
          this.storage.strokes.splice(idx, 1);
        }
        inverseOp = {
          type: 'deleteObject',
          payload: { objectId: action.id }
        };
        break;
      }
      case 'delete': {
        if (action.objectType === 'stroke') {
          this.storage.strokes.push(action.objectData);
        } else if (action.objectType === 'image') {
          this.storage.images.push(action.objectData);
        }
        inverseOp = {
          type: 'restoreObject',
          payload: {
            objectId: action.id,
            data: {
              id: action.id,
              type: action.objectType,
              ...action.objectData
            }
          }
        };
        break;
      }
      case 'move': {
        const img = this.storage.images.find(im => im.id === action.id);
        if (img) {
          img.x = action.before.x;
          img.y = action.before.y;
          img.w = action.before.w;
          img.h = action.before.h;
        }
        inverseOp = {
          type: 'moveObject',
          payload: {
            objectId: action.id,
            x: action.before.x,
            y: action.before.y,
            w: action.before.w,
            h: action.before.h
          }
        };
        break;
      }
      case 'add_image': {
        const idx = this.storage.images.findIndex(im => im.id === action.id);
        if (idx >= 0) {
          this.storage.images.splice(idx, 1);
        }
        if (this.storage.selected === action.image) {
          this.storage.selected = null;
        }
        inverseOp = {
          type: 'deleteObject',
          payload: { objectId: action.id }
        };
        break;
      }
      case 'clear': {
        this.storage.strokes = action.strokes.slice();
        this.storage.images = action.images.slice();
        // Since clear affects many objects, send custom clear restore or multiple restores
        this.storage.strokes.forEach(s => {
          this.network.send({
            type: 'restoreObject',
            payload: { objectId: s.id, data: { id: s.id, type: 'stroke', ...s } }
          });
        });
        this.storage.images.forEach(im => {
          this.network.send({
            type: 'restoreObject',
            payload: { objectId: im.id, data: { id: im.id, type: 'image', ...im } }
          });
        });
        break;
      }
    }

    this.redoStack.push(action);
    this.storage.recomputeContentRight();
    this.updateUI();
    this.onStateChanged();

    if (inverseOp && this.network) {
      this.network.send({
        type: 'undo',
        payload: { inverseOp }
      });
    }
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return;

    let op = null;

    switch (action.type) {
      case 'draw': {
        this.storage.strokes.push(action.stroke);
        op = {
          type: 'restoreObject',
          payload: {
            objectId: action.id,
            data: {
              id: action.id,
              type: 'stroke',
              ...action.stroke
            }
          }
        };
        break;
      }
      case 'delete': {
        if (action.objectType === 'stroke') {
          const idx = this.storage.strokes.findIndex(s => s.id === action.id);
          if (idx >= 0) this.storage.strokes.splice(idx, 1);
        } else if (action.objectType === 'image') {
          const idx = this.storage.images.findIndex(im => im.id === action.id);
          if (idx >= 0) this.storage.images.splice(idx, 1);
        }
        op = {
          type: 'deleteObject',
          payload: { objectId: action.id }
        };
        break;
      }
      case 'move': {
        const img = this.storage.images.find(im => im.id === action.id);
        if (img) {
          img.x = action.after.x;
          img.y = action.after.y;
          img.w = action.after.w;
          img.h = action.after.h;
        }
        op = {
          type: 'moveObject',
          payload: {
            objectId: action.id,
            x: action.after.x,
            y: action.after.y,
            w: action.after.w,
            h: action.after.h
          }
        };
        break;
      }
      case 'add_image': {
        this.storage.images.push(action.image);
        op = {
          type: 'restoreObject',
          payload: {
            objectId: action.id,
            data: {
              id: action.id,
              type: 'image',
              ...action.image
            }
          }
        };
        break;
      }
    }

    this.undoStack.push(action);
    this.storage.recomputeContentRight();
    this.updateUI();
    this.onStateChanged();

    if (op && this.network) {
      this.network.send({
        type: 'redo',
        payload: { op }
      });
    }
  }
}

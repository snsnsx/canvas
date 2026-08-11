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
        this.listFor(action.objectType).push(action.objectData);
        if (action.objectType === 'note') this.notesChanged();
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
      case 'add_note': {
        this.storage.removeNote(action.id);
        this.notesChanged();
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
      case 'batch_delete': {
        for (const item of action.items) {
          this.listFor(item.objectType).push(item.objectData);
          this.sendRestore(item.objectData, item.objectType);
        }
        if (action.items.some(item => item.objectType === 'note')) this.notesChanged();
        break;
      }
      case 'batch_move': {
        for (const item of action.items) {
          this.applySnapshot(item, item.before);
          const object = item.objectType === 'stroke'
            ? this.storage.strokes.find(s => s.id === item.id)
            : this.storage.images.find(im => im.id === item.id);
          if (object) this.sendRestore(object, item.objectType);
        }
        break;
      }
    }

    this.redoStack.push(action);
    this.storage.recomputeContentBottom();
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
        const list = this.listFor(action.objectType);
        const idx = list.findIndex(object => object.id === action.id);
        if (idx >= 0) list.splice(idx, 1);
        if (action.objectType === 'note') this.notesChanged();
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
      case 'add_note': {
        if (!this.storage.noteById(action.id)) this.storage.notes.push(action.note);
        this.notesChanged();
        op = {
          type: 'restoreObject',
          payload: {
            objectId: action.id,
            data: { type: 'note', ...action.note }
          }
        };
        break;
      }
      case 'batch_delete': {
        for (const item of action.items) {
          const list = this.listFor(item.objectType);
          const idx = list.findIndex(object => object.id === item.id);
          if (idx >= 0) list.splice(idx, 1);
          this.network.send({ type: 'deleteObject', payload: { objectId: item.id } });
        }
        if (action.items.some(item => item.objectType === 'note')) this.notesChanged();
        break;
      }
      case 'batch_move': {
        for (const item of action.items) {
          this.applySnapshot(item, item.after);
          const object = item.objectType === 'stroke'
            ? this.storage.strokes.find(s => s.id === item.id)
            : this.storage.images.find(im => im.id === item.id);
          if (object) this.sendRestore(object, item.objectType);
        }
        break;
      }
    }

    this.undoStack.push(action);
    this.storage.recomputeContentBottom();
    this.updateUI();
    this.onStateChanged();

    if (op && this.network) {
      this.network.send({
        type: 'redo',
        payload: { op }
      });
    }
  }

  applySnapshot(item, snapshot) {
    if (item.objectType === 'stroke') {
      const stroke = this.storage.strokes.find(s => s.id === item.id);
      if (!stroke) return;
      stroke.points = snapshot.points.map(p => ({ ...p }));
      this.storage.computeBBox(stroke);
      return;
    }
    const image = this.storage.images.find(im => im.id === item.id);
    if (!image) return;
    image.x = snapshot.x;
    image.y = snapshot.y;
    image.w = snapshot.w;
    image.h = snapshot.h;
  }

  // Куда возвращать объект: у каждого типа свой список в снимке доски.
  listFor(objectType) {
    if (objectType === 'stroke') return this.storage.strokes;
    if (objectType === 'note') return this.storage.notes;
    return this.storage.images;
  }

  // Плавающие окна — элементы DOM: перерисовка холста их не обновляет.
  notesChanged() {
    window.dispatchEvent(new CustomEvent('notesChanged'));
  }

  sendRestore(object, objectType) {
    let data;
    if (objectType === 'stroke') {
      data = { id: object.id, type: 'stroke', page: object.page, tool: object.tool, color: object.color, size: object.size, points: object.points };
    } else if (objectType === 'note') {
      data = { id: object.id, type: 'note', page: object.page, x: object.x, y: object.y, w: object.w, h: object.h, text: object.text };
    } else {
      data = { id: object.id, type: 'image', page: object.page, src: object.src, x: object.x, y: object.y, w: object.w, h: object.h };
    }
    this.network.send({ type: 'restoreObject', payload: { objectId: object.id, data } });
  }
}

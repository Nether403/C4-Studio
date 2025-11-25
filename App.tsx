import React, { useState, useRef, useEffect } from 'react';
import { Layer, AppMode, ModelTier, Toast } from './types';
import { generateImage, editImage } from './services/geminiService';
import { LayerItem } from './components/LayerItem';
import { Icon } from './components/Icons';

const App: React.FC = () => {
  // --- State ---
  const [layers, setLayers] = useState<Layer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>(AppMode.GENERATE);
  const [modelTier, setModelTier] = useState<ModelTier>(ModelTier.NANO_BANANA);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [activeTool, setActiveTool] = useState<string>('select');

  // --- Annotation State ---
  const [annotationTool, setAnnotationTool] = useState<'cursor' | 'brush' | 'rect' | 'arrow' | 'eraser' | 'text'>('cursor');
  const [brushColor, setBrushColor] = useState<string>('#8b5cf6'); // Default Violet
  const [brushSize, setBrushSize] = useState<number>(4);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState<{x: number, y: number} | null>(null);
  
  // Undo/Redo History
  const [history, setHistory] = useState<ImageData[]>([]);
  const [historyStep, setHistoryStep] = useState<number>(-1);
  const [snapshot, setSnapshot] = useState<ImageData | null>(null); // For shape preview

  // Text Tool State
  const [textInput, setTextInput] = useState<{x: number, y: number, visible: boolean}>({ x: 0, y: 0, visible: false });
  // We use a ref for the text value to avoid closure staleness in event handlers
  const textValueRef = useRef('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // --- Helper Functions ---

  const addToast = (message: string, type: 'success' | 'error' | 'info') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const addLayer = (url: string, type: Layer['type'], name: string) => {
    const newLayer: Layer = {
      id: Date.now().toString(),
      type,
      name,
      url,
      visible: true,
      opacity: 1,
    };
    setLayers(prev => [newLayer, ...prev]);
    setActiveLayerId(newLayer.id);
  };

  const handleDeleteLayer = (id: string) => {
    setLayers(prev => {
        const filtered = prev.filter(l => l.id !== id);
        // If we deleted the active layer, select the new top layer or null
        if (id === activeLayerId) {
            setActiveLayerId(filtered[0]?.id || null);
        }
        return filtered;
    });
    // If we deleted the annotation layer, clear history
    if (id === 'annotations-layer') {
        setHistory([]);
        setHistoryStep(-1);
        // Clear canvas visually
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  };

  // Ensure an annotation layer exists and is visible
  const ensureAnnotationLayer = () => {
    const existing = layers.find(l => l.id === 'annotations-layer');
    if (!existing) {
      const newLayer: Layer = {
        id: 'annotations-layer',
        type: 'segment', // Special type for annotation overlay
        name: 'Annotations',
        url: '', // Canvas overlay doesn't use URL
        visible: true,
        opacity: 1,
      };
      setLayers(prev => [newLayer, ...prev]);
      setActiveLayerId(newLayer.id);
    } else if (!existing.visible) {
        setLayers(prev => prev.map(l => l.id === existing.id ? { ...l, visible: true } : l));
        setActiveLayerId(existing.id);
    }
  };

  const handleToolSelect = (tool: typeof annotationTool) => {
    setAnnotationTool(tool);
    if (tool !== 'cursor') {
      ensureAnnotationLayer();
    }
  };

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        // Ignore if user is typing in an input or textarea
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') {
            return;
        }

        // Undo: Ctrl+Z
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            handleUndo();
        }
        // Redo: Ctrl+Shift+Z or Ctrl+Y
        if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') || ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
            e.preventDefault();
            handleRedo();
        }

        // Tool Shortcuts
        switch (e.key.toLowerCase()) {
            case 'v': handleToolSelect('cursor'); break;
            case 'b': handleToolSelect('brush'); break;
            case 'e': handleToolSelect('eraser'); break;
            case 't': handleToolSelect('text'); break;
            case 'r': handleToolSelect('rect'); break;
            case 'a': handleToolSelect('arrow'); break;
            case '[': setBrushSize(prev => Math.max(1, prev - 2)); break;
            case ']': setBrushSize(prev => Math.min(50, prev + 2)); break;
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyStep, history]); // Dependencies for Undo/Redo closure

  // --- Canvas Logic ---

  const updateCanvasSize = () => {
    if (canvasRef.current && imageRef.current) {
        // Only resize if dimensions differ to avoid clearing content
        if (canvasRef.current.width !== imageRef.current.clientWidth || 
            canvasRef.current.height !== imageRef.current.clientHeight) {
            
            canvasRef.current.width = imageRef.current.clientWidth;
            canvasRef.current.height = imageRef.current.clientHeight;
            
            // If we have history, restore the last step
            if (historyStep >= 0 && history[historyStep]) {
                const ctx = canvasRef.current.getContext('2d');
                if (ctx) ctx.putImageData(history[historyStep], 0, 0);
            }
        }
    }
  };

  const saveHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // If we are not at the end of history, slice it
    const newHistory = history.slice(0, historyStep + 1);
    newHistory.push(data);
    
    // Limit history size
    if (newHistory.length > 20) newHistory.shift();

    setHistory(newHistory);
    setHistoryStep(newHistory.length - 1);
  };

  const handleUndo = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    if (historyStep > 0) {
        const newStep = historyStep - 1;
        setHistoryStep(newStep);
        if (history[newStep]) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.putImageData(history[newStep], 0, 0);
        }
    } else if (historyStep === 0) {
        // Undo the first action = clear canvas
        setHistoryStep(-1);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const handleRedo = () => {
    if (historyStep < history.length - 1) {
        const newStep = historyStep + 1;
        setHistoryStep(newStep);
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx && history[newStep]) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.putImageData(history[newStep], 0, 0);
        }
    }
  };

  useEffect(() => {
    window.addEventListener('resize', updateCanvasSize);
    // Initial size check
    setTimeout(updateCanvasSize, 100);
    return () => window.removeEventListener('resize', updateCanvasSize);
  }, [activeLayerId]);

  // --- Drawing Handlers ---

  const startDrawing = (e: React.MouseEvent) => {
    if (annotationTool === 'cursor') return;
    
    // If text input is open, clicking canvas should commit it
    if (textInput.visible) {
        commitText();
        // If we are in text tool, just return after commit to let user click again to place
        if (annotationTool === 'text') return;
    }

    ensureAnnotationLayer();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    setIsDrawing(true);
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });

    // Text tool: Open input
    if (annotationTool === 'text') {
        textValueRef.current = ''; // Reset text
        setTextInput({ x, y, visible: true });
        setIsDrawing(false); 
        return;
    }

    // Save snapshot for shapes (rect, arrow) to restore background while dragging
    if (['rect', 'arrow'].includes(annotationTool)) {
        setSnapshot(ctx.getImageData(0, 0, canvas.width, canvas.height));
    }

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.strokeStyle = annotationTool === 'eraser' ? 'rgba(0,0,0,1)' : brushColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (annotationTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
    } else {
        ctx.globalCompositeOperation = 'source-over';
    }
  };

  const draw = (e: React.MouseEvent) => {
    if (!isDrawing || !startPos) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    if (annotationTool === 'brush' || annotationTool === 'eraser') {
        ctx.lineTo(currentX, currentY);
        ctx.stroke();
    } else if (annotationTool === 'rect') {
        if (snapshot) ctx.putImageData(snapshot, 0, 0);
        ctx.beginPath();
        const width = currentX - startPos.x;
        const height = currentY - startPos.y;
        ctx.strokeRect(startPos.x, startPos.y, width, height);
    } else if (annotationTool === 'arrow') {
        if (snapshot) ctx.putImageData(snapshot, 0, 0);
        drawArrow(ctx, startPos.x, startPos.y, currentX, currentY);
    }
  };

  const stopDrawing = () => {
    if (isDrawing) {
        setIsDrawing(false);
        setSnapshot(null);
        
        // Reset composite operation just in case
        const canvas = canvasRef.current;
        if (canvas) {
           const ctx = canvas.getContext('2d');
           if (ctx) ctx.globalCompositeOperation = 'source-over';
        }
        
        saveHistory();
    }
  };

  const drawArrow = (ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number) => {
    const headLength = 15 + brushSize; // Scale head with brush size
    const dx = toX - fromX;
    const dy = toY - fromY;
    const angle = Math.atan2(dy, dx);
    
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
    ctx.lineTo(toX, toY);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  };

  const commitText = () => {
    if (!textInput.visible) return;
    
    const text = textValueRef.current;
    if (!text.trim()) {
        setTextInput(prev => ({ ...prev, visible: false }));
        return;
    }
    
    const canvas = canvasRef.current;
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.font = `bold ${16 + brushSize * 2}px Inter, sans-serif`; // Scale font with brush size
            ctx.fillStyle = brushColor;
            ctx.textBaseline = 'top';
            ctx.fillText(text, textInput.x, textInput.y);
            saveHistory();
        }
    }
    textValueRef.current = '';
    setTextInput(prev => ({ ...prev, visible: false }));
  };

  // --- File/App Handlers ---

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 50 * 1024 * 1024) {
        addToast("File too large. Max 50MB.", "error");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        addLayer(result, 'image', file.name);
        setMode(AppMode.EDIT);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAction = async () => {
    if (!prompt.trim()) {
      addToast("Please enter a prompt.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      let resultImage = '';
      
      if (mode === AppMode.GENERATE) {
        resultImage = await generateImage(prompt + (negativePrompt ? ` --no ${negativePrompt}` : ''), modelTier);
        addLayer(resultImage, 'generation', `Gen: ${prompt.slice(0, 15)}...`);
      } else {
        const activeLayer = layers.find(l => l.id === activeLayerId && l.id !== 'annotations-layer');
        if (!activeLayer) {
           // If on annotation layer, find first image layer
           const imgLayer = layers.find(l => l.type === 'image' || l.type === 'generation');
           if (!imgLayer) {
              addToast("Select a valid image layer to edit.", "error");
              setIsProcessing(false);
              return;
           }
           resultImage = await editImage(imgLayer.url, prompt + (negativePrompt ? ` --no ${negativePrompt}` : ''), modelTier);
           addLayer(resultImage, 'image', `Edit: ${imgLayer.name}`);
        } else {
           resultImage = await editImage(activeLayer.url, prompt + (negativePrompt ? ` --no ${negativePrompt}` : ''), modelTier);
           addLayer(resultImage, 'image', `Edit: ${activeLayer.name}`);
        }
      }
      addToast("Processing complete!", "success");
      setPrompt("");
    } catch (error: any) {
      addToast(error.message || "Operation failed", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleQuickAction = (actionPrompt: string) => {
    setPrompt(actionPrompt);
  };

  const handleExport = () => {
    // Determine which layer to export (active or visible)
    const exportLayer = layers.find(l => l.id === activeLayerId && l.id !== 'annotations-layer') 
                     || layers.find(l => l.type !== 'segment' && l.visible);
    
    if (!exportLayer) {
      addToast("No valid image layer to export", "error");
      return;
    }

    const annotationLayer = layers.find(l => l.id === 'annotations-layer');
    const hasAnnotations = annotationLayer && annotationLayer.visible && historyStep >= 0;

    if (hasAnnotations && canvasRef.current) {
        // Smart Export: Composite Image + Annotations
        const tempCanvas = document.createElement('canvas');
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = exportLayer.url;
        
        img.onload = () => {
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const ctx = tempCanvas.getContext('2d');
            if (ctx) {
                // 1. Draw Image
                ctx.drawImage(img, 0, 0);
                
                // 2. Draw Annotations (scaled to match original image resolution)
                // We must draw the current visible canvas onto the temp canvas
                // Note: The on-screen canvas matches the displayed size of the image, 
                // but the internal resolution might match the rendered width/height.
                // Best approach: Draw the annotation canvas directly scaling it.
                ctx.drawImage(canvasRef.current!, 0, 0, img.width, img.height);
                
                // 3. Download
                const link = document.createElement('a');
                link.href = tempCanvas.toDataURL('image/png');
                link.download = `c4-export-annotated-${Date.now()}.png`;
                link.click();
                addToast("Exported with annotations!", "success");
            }
        };
    } else {
        // Simple Export
        const link = document.createElement('a');
        link.href = exportLayer.url;
        link.download = `c4-export-${exportLayer.name}.png`;
        link.click();
        addToast("Export started", "success");
    }
  };

  const handleMagicTool = async () => {
    const activeLayer = layers.find(l => l.id === activeLayerId && l.id !== 'annotations-layer');
    if (!activeLayer) {
        addToast("Select an image layer for magic tool", "error");
        return;
    }
    
    setIsProcessing(true);
    try {
        const result = await editImage(activeLayer.url, "Segment the main subject and make background transparent", modelTier);
        addLayer(result, 'segment', `Segment: ${activeLayer.name}`);
        addToast("Magic segmentation complete", "success");
    } catch (e: any) {
        addToast("Magic tool failed: " + e.message, "error");
    } finally {
        setIsProcessing(false);
    }
  };

  const activeLayer = layers.find(l => l.id === activeLayerId);
  const annotationLayer = layers.find(l => l.id === 'annotations-layer');
  const isAnnotationVisible = annotationLayer ? annotationLayer.visible : true;
  // Fallback to display ANY active layer if current is annotation, for background
  const displayLayer = (activeLayer && activeLayer.id !== 'annotations-layer') 
    ? activeLayer 
    : layers.find(l => l.id !== 'annotations-layer' && l.visible);

  return (
    <div className="flex h-screen w-screen bg-[#02040a] text-white overflow-hidden selection:bg-orange-500 selection:text-white">
      
      {/* --- Left Sidebar (Tools) --- */}
      <div className="w-20 border-r border-slate-800 bg-[#050810] flex flex-col items-center py-6 gap-8 z-20">
        <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-lg flex items-center justify-center shadow-lg shadow-orange-900/50 mb-4">
          <span className="font-heading font-bold text-xl text-white">C4</span>
        </div>

        {/* Tools Nav */}
        <div className="flex flex-col gap-6 w-full px-2">
            {[
                { id: 'select', icon: 'cursor', label: 'SELECT' },
                { id: 'crop', icon: 'crop', label: 'CROP' },
                { id: 'filters', icon: 'sparkle', label: 'FILTERS' },
                { id: 'magic', icon: 'magic-wand', label: 'MAGIC' }
            ].map(tool => (
                <button
                    key={tool.id}
                    onClick={() => {
                        setActiveTool(tool.id);
                        if (tool.id === 'select') setAnnotationTool('cursor');
                        if (tool.id === 'magic') handleMagicTool();
                    }}
                    className={`flex flex-col items-center gap-1 group relative p-2 rounded-lg transition-all
                        ${activeTool === tool.id ? 'text-orange-500' : 'text-slate-500 hover:text-slate-300'}
                    `}
                >
                    <div className={`p-2 rounded-md ${activeTool === tool.id ? 'bg-orange-500/20' : ''}`}>
                         <Icon name={tool.icon} className="text-2xl" weight={activeTool === tool.id ? 'fill' : 'regular'} />
                    </div>
                    <span className="text-[10px] font-bold tracking-wider">{tool.label}</span>
                    {activeTool === tool.id && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-orange-500 rounded-r-full -ml-2" />}
                </button>
            ))}
        </div>
      </div>

      {/* --- Main Content Area --- */}
      <div className="flex-1 flex flex-col relative min-w-0">
        
        {/* Top Bar */}
        <div className="h-16 border-b border-slate-800 bg-[#050810]/80 backdrop-blur-md flex items-center justify-between px-6 z-10">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="font-heading font-bold text-xl tracking-wide uppercase">
                {displayLayer ? displayLayer.name : "Untitled Canvas"}
              </h2>
              <div className="text-xs text-slate-500 font-medium tracking-widest uppercase flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${mode === AppMode.EDIT ? 'bg-blue-500' : 'bg-purple-500'}`}></span>
                {mode === AppMode.EDIT ? 'Layered Edit Session' : 'Generative Session'}
              </div>
            </div>
            
            <div className="h-8 w-px bg-slate-800 mx-2"></div>
            
            {/* Quick Actions */}
            <div className="flex gap-2">
                {[
                    { label: 'Clean Background', prompt: 'Remove the background and keep it clean' },
                    { label: 'Portrait Glow', prompt: 'Add a soft portrait glow lighting effect' },
                    { label: 'Cyberpunk', prompt: 'Convert to cyberpunk style, neon lights, dark atmosphere' }
                ].map((qa, i) => (
                    <button 
                        key={i}
                        onClick={() => handleQuickAction(qa.prompt)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
                    >
                        <Icon name="sparkle" weight="fill" className="text-orange-400" />
                        {qa.label}
                    </button>
                ))}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button 
                onClick={handleExport}
                className="px-6 py-2 bg-slate-100 hover:bg-white text-slate-900 font-bold font-heading uppercase tracking-wider text-sm rounded transition-colors shadow-lg shadow-white/10"
            >
              Export
            </button>
            <div className="flex items-center gap-2 text-green-500 text-xs font-medium bg-green-900/20 px-3 py-1.5 rounded-full border border-green-900/50">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                Connected
            </div>
          </div>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative flex items-center justify-center bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] bg-[#02040a] overflow-hidden">
            {/* Grid Pattern Overlay */}
            <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, #334155 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

            {displayLayer ? (
                <div className="relative inline-flex justify-center items-center max-w-[80vw] max-h-[80vh] group">
                   <img 
                      ref={imageRef}
                      src={displayLayer.url} 
                      className="max-w-full max-h-[80vh] w-auto h-auto object-contain shadow-2xl shadow-black border border-slate-700/50 bg-slate-900/50" 
                      style={{ opacity: displayLayer.visible ? displayLayer.opacity : 0 }}
                      onLoad={updateCanvasSize}
                   />
                   
                   {/* Canvas Overlay for Annotations */}
                   <canvas
                      ref={canvasRef}
                      className={`absolute inset-0 w-full h-full touch-none z-10 
                          ${annotationTool === 'cursor' ? 'pointer-events-none' : 'cursor-crosshair'}
                          ${!isAnnotationVisible ? 'opacity-0 pointer-events-none' : 'opacity-100'}
                      `}
                      onMouseDown={startDrawing}
                      onMouseMove={draw}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                   />

                   {/* Text Input Overlay */}
                   {textInput.visible && (
                        <input
                            autoFocus
                            defaultValue={textValueRef.current} // Use defaultValue to prevent controlled component issues with Ref
                            onChange={(e) => { textValueRef.current = e.target.value; }}
                            onKeyDown={(e) => { if(e.key === 'Enter') commitText(); }}
                            onBlur={commitText}
                            style={{ 
                                left: textInput.x, 
                                top: textInput.y,
                                color: brushColor,
                                borderBottom: `2px solid ${brushColor}`,
                                fontSize: `${16 + brushSize * 2}px`
                            }}
                            className="absolute z-30 bg-transparent outline-none font-bold min-w-[100px] placeholder-white/30 drop-shadow-md"
                            placeholder="Type..."
                        />
                   )}

                   {/* Annotation Toolbar Floating over content */}
                   <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 p-1.5 rounded-full bg-slate-900/90 border border-slate-700 backdrop-blur-md shadow-2xl z-50 transition-opacity opacity-0 group-hover:opacity-100 hover:opacity-100 min-w-max">
                        {/* Tools */}
                        
                        {/* 1. Arrow Tool */}
                        <button onClick={() => handleToolSelect('arrow')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'arrow' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Arrow (A)">
                           <Icon name="arrow-up-right" weight="bold" />
                        </button>

                        <div className="w-px h-4 bg-slate-700 mx-1"></div>

                        {/* 2. Square Tool */}
                        <button onClick={() => handleToolSelect('rect')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'rect' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Box (R)">
                           <Icon name="square" weight="bold" />
                        </button>

                        {/* 3. Brush Tool */}
                        <button onClick={() => handleToolSelect('brush')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'brush' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Brush (B)">
                           <Icon name="pencil-simple" weight="fill" />
                        </button>
                        
                        {/* Text Tool */}
                         <button onClick={() => handleToolSelect('text')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'text' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Text (T)">
                           <Icon name="text-t" weight="bold" />
                        </button>

                        {/* 4. Eraser Tool */}
                        <button onClick={() => handleToolSelect('eraser')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'eraser' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Eraser (E)">
                           <Icon name="eraser" weight="fill" />
                        </button>
                        
                        <div className="w-px h-4 bg-slate-700 mx-1"></div>
                        
                        {/* 5. Color Selector */}
                        <div className="relative w-9 h-9 flex items-center justify-center rounded-full hover:bg-slate-700 transition-colors overflow-hidden group/color">
                            <input 
                                type="color" 
                                className="absolute inset-0 w-[150%] h-[150%] opacity-0 cursor-pointer -top-2 -left-2"
                                value={brushColor}
                                onChange={(e) => setBrushColor(e.target.value)}
                            />
                            <div className="w-5 h-5 rounded-full border border-white/20 shadow-sm pointer-events-none" style={{ backgroundColor: brushColor }}></div>
                        </div>

                        {/* Brush Size Slider */}
                        <div className="flex items-center px-2 w-24 group/slider">
                            <input 
                                type="range" 
                                min="2" 
                                max="20" 
                                value={brushSize} 
                                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                                className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400 hover:accent-orange-500"
                                title={`Brush Size: ${brushSize}`}
                            />
                        </div>

                        <div className="w-px h-4 bg-slate-700 mx-1"></div>
                        
                        {/* Undo/Redo */}
                        <button onClick={handleUndo} disabled={historyStep < 0} className="p-2 rounded-full hover:bg-slate-700 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed" title="Undo (Ctrl+Z)">
                           <Icon name="arrow-u-up-left" weight="bold" />
                        </button>
                        <button onClick={handleRedo} disabled={historyStep >= history.length - 1} className="p-2 rounded-full hover:bg-slate-700 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed" title="Redo (Ctrl+Y)">
                           <Icon name="arrow-u-up-right" weight="bold" />
                        </button>
                        
                        <div className="w-px h-4 bg-slate-700 mx-1"></div>
                        
                        {/* Close/Cursor */}
                        <button onClick={() => handleToolSelect('cursor')} className={`p-2 rounded-full hover:bg-slate-700 transition-colors ${annotationTool === 'cursor' ? 'text-white bg-slate-700' : 'text-slate-400'}`} title="Close Tools (V)">
                           <Icon name="x" weight="bold" />
                        </button>
                   </div>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center text-center p-12 border border-dashed border-slate-700 rounded-2xl bg-slate-900/30 max-w-lg mx-auto transition-all">
                    
                    {/* Mode Toggle In Center */}
                    <div className="flex bg-slate-800/80 p-1 rounded-lg mb-8 border border-slate-700 backdrop-blur-sm">
                        <button
                            onClick={() => setMode(AppMode.EDIT)}
                            className={`flex items-center gap-2 px-6 py-2 rounded-md text-sm font-bold uppercase tracking-wider transition-all ${
                                mode === AppMode.EDIT 
                                ? 'bg-slate-700 text-white shadow-lg' 
                                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50'
                            }`}
                        >
                            <Icon name="pencil-simple" weight={mode === AppMode.EDIT ? "fill" : "regular"} />
                            Edit
                        </button>
                        <button
                            onClick={() => setMode(AppMode.GENERATE)}
                            className={`flex items-center gap-2 px-6 py-2 rounded-md text-sm font-bold uppercase tracking-wider transition-all ${
                                mode === AppMode.GENERATE 
                                ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20' 
                                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50'
                            }`}
                        >
                            <Icon name="sparkle" weight={mode === AppMode.GENERATE ? "fill" : "regular"} />
                            Generate
                        </button>
                    </div>

                    {mode === AppMode.EDIT ? (
                        <>
                            <div className="w-16 h-16 mb-6 rounded-2xl bg-slate-800 flex items-center justify-center text-orange-500 shadow-lg shadow-orange-900/20">
                                <Icon name="image" className="text-4xl" />
                            </div>
                            <h3 className="font-heading text-2xl font-bold mb-2">Start Creating</h3>
                            <p className="text-slate-400 mb-8 max-w-md">
                                Drag and drop an image here, or upload one to start editing. Switch to Generate mode to create from scratch.
                            </p>
                            <label className="cursor-pointer group relative">
                                <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                                <div className="absolute inset-0 bg-orange-500 blur opacity-20 group-hover:opacity-40 transition-opacity"></div>
                                <span className="relative px-6 py-3 bg-slate-800 border border-slate-600 rounded-lg text-sm font-bold uppercase tracking-wider group-hover:border-orange-500 group-hover:text-white transition-all flex items-center gap-2">
                                     <Icon name="upload-simple" /> Upload Image
                                </span>
                            </label>
                        </>
                    ) : (
                        <>
                             {/* Generate Mode Content */}
                            <div className="w-16 h-16 mb-6 rounded-2xl bg-transparent flex items-center justify-center text-blue-400">
                                <Icon name="magic-wand" weight="fill" className="text-5xl drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]" />
                            </div>
                            <h3 className="font-heading text-2xl font-bold mb-4 tracking-wide uppercase">Describe the scene you need</h3>
                            
                            <div className="px-4 py-2 bg-slate-800 rounded-lg text-slate-400 text-xs font-mono border border-slate-700">
                                Press <span className="text-slate-300 font-bold">Ctrl/Cmd + Enter</span> to generate
                            </div>
                        </>
                    )}
                </div>
            )}
            
            {/* Loading Overlay */}
            {isProcessing && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
                    <div className="relative w-20 h-20">
                        <div className="absolute inset-0 border-4 border-slate-700 rounded-full"></div>
                        <div className="absolute inset-0 border-t-4 border-orange-500 rounded-full animate-spin"></div>
                    </div>
                    <p className="mt-6 font-heading text-xl font-bold tracking-widest animate-pulse">PROCESSING</p>
                    <p className="text-slate-400 text-sm mt-2">Connecting to Neural Engine...</p>
                </div>
            )}
        </div>
      </div>

      {/* --- Right Panel --- */}
      <div className="w-96 bg-[#050810] border-l border-slate-800 flex flex-col z-20">
        
        {/* Model Selector */}
        <div className="p-4 border-b border-slate-800">
            <div className="bg-slate-900 rounded-lg p-1 flex gap-1 border border-slate-800">
                 {[
                    { id: ModelTier.NANO_BANANA, label: 'Nano Banana', sub: 'Fast' },
                    { id: ModelTier.NANO_BANANA_PRO, label: 'Banana Pro', sub: 'High Fidelity' }
                 ].map(m => (
                     <button
                        key={m.id}
                        onClick={() => setModelTier(m.id)}
                        className={`flex-1 py-2 px-3 rounded text-left transition-all ${modelTier === m.id ? 'bg-gradient-to-r from-orange-900/40 to-red-900/40 border border-orange-500/50' : 'hover:bg-slate-800 border border-transparent'}`}
                     >
                        <div className={`font-bold text-xs uppercase tracking-wider ${modelTier === m.id ? 'text-orange-400' : 'text-slate-300'}`}>{m.label}</div>
                        <div className="text-[10px] text-slate-500 font-medium">{m.sub}</div>
                     </button>
                 ))}
            </div>
        </div>

        {/* Mode Toggles */}
        <div className="flex gap-4 p-6 pb-2">
            <button 
                onClick={() => setMode(AppMode.EDIT)}
                className={`flex-1 pb-2 text-sm font-bold uppercase tracking-wider border-b-2 transition-colors ${mode === AppMode.EDIT ? 'border-orange-500 text-white' : 'border-transparent text-slate-600 hover:text-slate-400'}`}
            >
                Edit
            </button>
            <button 
                onClick={() => setMode(AppMode.GENERATE)}
                className={`flex-1 pb-2 text-sm font-bold uppercase tracking-wider border-b-2 transition-colors ${mode === AppMode.GENERATE ? 'border-orange-500 text-white' : 'border-transparent text-slate-600 hover:text-slate-400'}`}
            >
                Generate
            </button>
        </div>

        {/* Controls Scroll Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
            
            {/* Import Button (if active layer needed but none) */}
            {mode === AppMode.EDIT && !activeLayer && (
                 <label className="block w-full py-4 border-2 border-dashed border-slate-700 rounded-lg text-center cursor-pointer hover:border-orange-500/50 hover:bg-slate-900 transition-all">
                    <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                    <Icon name="upload-simple" className="text-xl mb-1 text-slate-400" />
                    <div className="text-xs font-bold uppercase text-slate-500">Import Source Image</div>
                 </label>
            )}

            {/* Prompt Inputs */}
            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <label className="text-xs font-bold uppercase text-slate-400 tracking-wider">
                        {mode === AppMode.EDIT ? 'Editing Prompt' : 'Generation Prompt'}
                    </label>
                    <span className="text-[10px] text-orange-500 font-mono">0/2000</span>
                </div>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                        if((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleAction();
                    }}
                    placeholder={mode === AppMode.EDIT ? "Relight the subject, change background..." : "Ultra-wide hero shot of a desert city..."}
                    className="w-full h-32 bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 resize-none transition-all"
                />

                <div>
                    <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-2 block">
                        Negative Prompt
                    </label>
                    <textarea
                        value={negativePrompt}
                        onChange={(e) => setNegativePrompt(e.target.value)}
                        placeholder="Artifacts to avoid (blur, watermark)..."
                        className="w-full h-20 bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 resize-none"
                    />
                </div>
            </div>
            
            {/* Preset Styles */}
            <div>
                 <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-3 block">Style Presets</label>
                 <div className="grid grid-cols-2 gap-2">
                    {['Cinematic Matte', 'Golden Hour', 'Cyber Neon', 'Analog Film'].map(style => (
                        <button 
                            key={style}
                            onClick={() => setPrompt(prev => prev + `, ${style} style`)}
                            className="text-xs py-2 px-3 bg-slate-900 border border-slate-800 rounded hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-all text-left truncate"
                        >
                            {style}
                        </button>
                    ))}
                 </div>
            </div>
        </div>

        {/* Action Button */}
        <div className="p-6 border-t border-slate-800 bg-[#050810]">
             <button
                onClick={handleAction}
                disabled={isProcessing || (mode === AppMode.EDIT && !activeLayer)}
                className={`w-full py-4 rounded-lg font-heading font-bold text-lg tracking-widest uppercase flex items-center justify-center gap-2 transition-all shadow-lg
                    ${isProcessing || (mode === AppMode.EDIT && !activeLayer) 
                        ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                        : 'bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white shadow-orange-900/20 hover:shadow-orange-500/40'}
                `}
             >
                {isProcessing ? (
                    <><div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> Processing...</>
                ) : (
                    <><Icon name="sparkle" weight="fill" /> {mode === AppMode.EDIT ? 'Run Edit' : 'Generate Image'}</>
                )}
             </button>
        </div>

        {/* Layers Panel */}
        <div className="h-64 border-t border-slate-800 flex flex-col bg-slate-900/30">
            <div className="p-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Icon name="stack" className="text-slate-400" />
                    <span className="text-xs font-bold uppercase text-slate-300">Layers</span>
                </div>
                <button className="text-[10px] bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300 transition-colors">
                    + New Layer
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {layers.length === 0 ? (
                    <div className="text-center py-8 text-slate-600 text-xs italic">Layers will appear here</div>
                ) : (
                    layers.map(layer => (
                        <LayerItem 
                            key={layer.id} 
                            layer={layer} 
                            isActive={activeLayerId === layer.id}
                            onSelect={setActiveLayerId}
                            onToggleVisibility={(id) => {
                                setLayers(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
                            }}
                            onDelete={handleDeleteLayer}
                        />
                    ))
                )}
            </div>
        </div>

      </div>

      {/* Toast Container */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
         {toasts.map(toast => (
             <div 
                key={toast.id}
                className={`pointer-events-auto min-w-[300px] p-4 rounded-lg shadow-2xl border-l-4 flex items-center gap-3 animate-[slideIn_0.3s_ease-out]
                    ${toast.type === 'success' ? 'bg-slate-900 border-green-500 text-green-100' : ''}
                    ${toast.type === 'error' ? 'bg-slate-900 border-red-500 text-red-100' : ''}
                    ${toast.type === 'info' ? 'bg-slate-900 border-blue-500 text-blue-100' : ''}
                `}
             >
                <Icon 
                    name={toast.type === 'success' ? 'check-circle' : toast.type === 'error' ? 'warning' : 'info'} 
                    weight="fill"
                    className="text-xl"
                />
                <span className="text-sm font-medium">{toast.message}</span>
             </div>
         ))}
      </div>

    </div>
  );
};

export default App;
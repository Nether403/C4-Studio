import React from 'react';
import { Layer } from '../types';
import { Icon } from './Icons';

interface LayerItemProps {
  layer: Layer;
  isActive: boolean;
  onSelect: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onDelete: (id: string) => void;
}

export const LayerItem: React.FC<LayerItemProps> = ({ layer, isActive, onSelect, onToggleVisibility, onDelete }) => {
  const isAnnotation = layer.id === 'annotations-layer';

  return (
    <div 
      onClick={() => onSelect(layer.id)}
      className={`
        group flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all border border-transparent relative
        ${isActive ? 'bg-orange-500/10 border-orange-500/50' : 'hover:bg-slate-800 border-slate-800'}
      `}
    >
      <div 
        onClick={(e) => { e.stopPropagation(); onToggleVisibility(layer.id); }}
        className={`text-slate-400 hover:text-white cursor-pointer ${!layer.visible && 'opacity-50'}`}
      >
        <Icon name={layer.visible ? 'eye' : 'eye-slash'} weight="fill" className="text-lg" />
      </div>
      
      <div className={`w-10 h-10 rounded overflow-hidden border border-slate-700 shrink-0 flex items-center justify-center ${isAnnotation ? 'bg-purple-900/20 text-purple-400' : 'bg-slate-900'}`}>
        {isAnnotation ? (
          <Icon name="pencil-simple" weight="fill" className="text-xl" />
        ) : (
          <img src={layer.url} alt={layer.name} className="w-full h-full object-cover" />
        )}
      </div>

      <div className="flex flex-col min-w-0 flex-1">
        <span className={`text-sm font-medium truncate ${isActive ? 'text-orange-100' : 'text-slate-200'}`}>
          {layer.name}
        </span>
        <span className="text-xs text-slate-500 uppercase font-bold tracking-wider">
          {layer.type}
        </span>
      </div>

      {/* Delete Button - Visible on hover or if active */}
      <button 
        onClick={(e) => { e.stopPropagation(); onDelete(layer.id); }}
        className={`
          opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-all
          ${isActive ? 'opacity-100' : ''}
        `}
        title="Delete Layer"
      >
        <Icon name="trash" weight="bold" />
      </button>
    </div>
  );
};
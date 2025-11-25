import React from 'react';

// Using className for Tailwind styling on <i> tags provided by Phosphor script
export const Icon: React.FC<{ name: string; className?: string; weight?: string }> = ({ name, className = "", weight = "regular" }) => {
  return <i className={`ph-${weight} ph-${name} ${className}`} />;
};
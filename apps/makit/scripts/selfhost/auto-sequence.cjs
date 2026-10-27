function maximumAutoNumber(field,records) {
  const format=field.property?.auto_serial;
  if(format?.type!=='custom') return records.reduce((maximum,record)=>{
    const value=record.fields[field.name];
    if(value==null || value==='') return maximum;
    if(!Number.isSafeInteger(Number(value)) || Number(value)<0) throw new Error('Invalid source sequence value');
    return Math.max(maximum,Number(value));
  },0);
  let groups=0;
  const escape=(value)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expression=(format.options || []).map((part)=>{
    if(part.type==='fixed_text') return escape(part.value);
    if(part.type==='created_time' && part.value==='yyyyMMdd') return '\\d{8}';
    if(part.type==='system_number') {
      const width=Number(part.value); if(!Number.isInteger(width) || width<1 || width>12 || groups++) throw new Error('Unsupported sequence format');
      return `(\\d{${width},})`;
    }
    throw new Error('Unsupported sequence format');
  }).join('');
  if(groups!==1) throw new Error('Sequence number segment is missing');
  const regex=new RegExp(`^${expression}$`);
  return records.reduce((maximum,record)=>{
    const value=record.fields[field.name]; if(value==null || value==='') return maximum;
    const match=regex.exec(String(value));
    if(!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Source sequence does not match its format');
    return Math.max(maximum,Number(match[1]));
  },0);
}
module.exports={maximumAutoNumber};

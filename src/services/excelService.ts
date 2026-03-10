import * as XLSX from 'xlsx';
import { Appearance } from './geminiService';

export interface AttendanceRecord {
  id: string;
  personId: string;
  name: string;
  studentId?: string;
  description: string;
  appearances: Appearance[];
}

export function exportToExcel(data: AttendanceRecord[], fileName: string = 'attendance.xlsx') {
  const worksheetData = data.map((record, index) => ({
    '序号': index + 1,
    '人员标识': record.personId || record.id,
    '姓名': record.name || '未填写',
    '学号': record.studentId || '未填写',
    '特征描述': record.description,
    '出现图片': record.appearances.map(a => a.imageName || `图片${a.imageIndex}`).join(', '),
    '导出时间': new Date().toLocaleString(),
  }));

  const worksheet = XLSX.utils.json_to_sheet(worksheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '签到表');

  XLSX.writeFile(workbook, fileName);
}

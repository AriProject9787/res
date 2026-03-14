// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const loadingIndicator = document.getElementById('loadingIndicator');

// Global storage for the extracted data as a flat array
window.allExtractedData = [];


// Function to extract text and coordinates from a PDF and structure it
async function processPDF(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;
    
    // Structure: { "01": { subjectCodes: Set, students: Map } }
    let semestersData = {};
    
    // PERSISTENT CONTEXT ACROSS PAGES
    let currentSemesterNo = 'Unknown';
    let currentColumnMap = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items;

        // Group items into rows by Y-coordinate
        let rowsMap = new Map();
        
        items.forEach(item => {
            // pdf.js Y coordinates are from bottom-up.
            // Small tolerance to group items on same visual line.
            const y = Math.round(item.transform[5] / 3) * 3;
            if (!rowsMap.has(y)) rowsMap.set(y, []);
            rowsMap.get(y).push({
                text: item.str.trim(),
                x: item.transform[4],
                y: item.transform[5]
            });
        });

        // Sort rows map by Y descending (top to bottom)
        const sortedY = Array.from(rowsMap.keys()).sort((a, b) => b - a);
        let rows = sortedY.map(y => rowsMap.get(y));

        // Sort items in each row by X ascending (left to right)
        rows.forEach(row => {
            row.sort((a, b) => a.x - b.x);
        });
        
        // 0. Extract Semester Number for this page
        let detectedSemesterNo = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].str.includes('Semester No.')) {
                const match = items[i].str.match(/Semester No\.\s*:\s*0*(\d+)/);
                if (match) {
                    detectedSemesterNo = match[1];
                } else if (i + 1 < items.length && items[i+1].str.match(/^\s*0*(\d+)\s*$/)) {
                    detectedSemesterNo = items[i+1].str.replace(/^0+/, '');
                }
                break;
            }
        }
        
        // Update persistent semester context if found
        if (detectedSemesterNo) {
            currentSemesterNo = detectedSemesterNo;
        }
        
        if (!semestersData[currentSemesterNo]) {
            semestersData[currentSemesterNo] = {
                subjectCodes: new Set(),
                students: new Map() // Maps regNum -> { name, grades: {} }
            };
        }
        const currentSemData = semestersData[currentSemesterNo];

        // 1. Identify columns and subject codes for this page
        // Find the headers line using typical text like "Reg. Number"
        let headerRowIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const rowText = rows[i].map(r => r.text).join(' ');
            if (rowText.includes('Reg. Number') || rowText.includes('Stud. Name') || (rowText.includes('Grad') && rows[i].length > 10)) {
                headerRowIndex = i;
                break;
            }
        }
        
        // To find the subject codes, we look at rows slightly above the header row, or extract column headers
        const xTolerance = 12; // 12 pixels horizontal tolerance
        
        if (headerRowIndex > 1) {
             let tempColumnMap = [];
             let subjPartsRow1 = rows[headerRowIndex - 2].filter(item => item.text !== 'Subject' && item.text !== 'Code' && item.text !== '-' && item.text !== '>');
             let subjPartsRow2 = rows[headerRowIndex - 1];
             
             // Try to merge them by X coordinate
             let candidates = [...subjPartsRow1, ...subjPartsRow2];
             
             // Group by X
             let xGroups = [];
             candidates.forEach(cand => {
                 if (cand.text.length === 0) return;
                 let foundGroup = xGroups.find(g => Math.abs(g.x - cand.x) < xTolerance);
                 if (foundGroup) {
                     foundGroup.items.push(cand);
                     foundGroup.x = (foundGroup.x + cand.x) / 2;
                 } else {
                     xGroups.push({ x: cand.x, items: [cand] });
                 }
             });
             
             // Build subject codes
             xGroups.forEach(group => {
                 group.items.sort((a,b) => b.y - a.y);
                 const code = group.items.map(i => i.text).join('');
                 if (code.match(/^[A-Z0-9]+$/)) {
                     tempColumnMap.push({ x: group.x, code: code });
                     currentSemData.subjectCodes.add(code); 
                 }
             });

             // If we successfully found a column map on this page, update context
             if (tempColumnMap.length > 0) {
                 currentColumnMap = tempColumnMap;
             }
        }
        
        // 2. Parse students and grades
        const regNumRegex = /^(\d{12})$/;
        const gradeTokensRegex = /^(O|A\+|A|B\+|B|C|U|UA|W|WH|I)$/;
        
        // If we don't have a headerRowIndex, we start scanning from the top
        let scanStartIndex = headerRowIndex !== -1 ? headerRowIndex + 1 : 0;

        for (let i = scanStartIndex; i < rows.length; i++) {
            const row = rows[i];
            
            // Check if this row is a student record (first item or similar is a 12-digit number)
            let regNumItem = row.find(item => regNumRegex.test(item.text));
            if (!regNumItem) continue; // Not a student row

            const regNumber = regNumItem.text;
            
            // The items after the reg number contain the student name and grades.
            let studentNameParts = [];
            let gradeResults = {};
            
            row.forEach(item => {
                if (item === regNumItem) return;
                
                // If it's a perfect grade string AND it roughly aligns with a known column, it's a grade
                const isGradeString = gradeTokensRegex.test(item.text);
                
                let matchedCol = null;
                if (isGradeString) {
                     // Find if it aligns with a subject column in the current context
                     matchedCol = currentColumnMap.find(col => Math.abs(col.x - item.x) < xTolerance);
                }
                
                if (isGradeString && matchedCol) {
                    gradeResults[matchedCol.code] = item.text;
                } else if (item.text.length > 0) {
                    // It must be part of the student's name
                    studentNameParts.push(item.text);
                }
            });

            // If we couldn't resolve any column headers (e.g. edge case PDF), we just fallback to raw grades
            if (Object.keys(gradeResults).length === 0) {
                // Collect any grade looking things that we threw into names mistakenly
                let unknownIndex = 1;
                for (let k = studentNameParts.length - 1; k >= 0; k--) {
                     if (gradeTokensRegex.test(studentNameParts[k])) {
                          gradeResults[`Unknown${unknownIndex++}`] = studentNameParts[k];
                          studentNameParts.pop();
                     } else {
                          break;
                     }
                }
            }
            
            let fullStudentName = studentNameParts.join(' ');

            if (!currentSemData.students.has(regNumber)) {
                currentSemData.students.set(regNumber, {
                    regNumber: regNumber,
                    studentName: fullStudentName,
                    grades: gradeResults
                });
            } else {
                // Student might span across pages, merge grades
                const existing = currentSemData.students.get(regNumber);
                Object.assign(existing.grades, gradeResults);
                if (!existing.studentName && fullStudentName) {
                    existing.studentName = fullStudentName;
                }
            }
        }
    }

    // Also store as a flat array globally for the user
    window.allExtractedData = [];
    Object.keys(semestersData).forEach(sem => {
        semestersData[sem].students.forEach(student => {
            window.allExtractedData.push({
                semester: sem,
                regNumber: student.regNumber,
                studentName: student.studentName,
                grades: student.grades
            });
        });
    });

    return semestersData;
}

// Function to display the results in the HTML tables
function displayResults(semestersData) {
    const container = document.getElementById('tablesContainer');
    container.innerHTML = ''; // Clear existing
    
    // Sort semesters numerically
    const sems = Object.keys(semestersData).sort((a,b) => {
        let na = parseInt(a), nb = parseInt(b);
        if(isNaN(na)) na = 999;
        if(isNaN(nb)) nb = 999;
        return na - nb;
    });
    
    if (sems.length === 0) {
        container.innerHTML = '<p>No results found or error parsing PDF.</p>';
        return;
    }

    sems.forEach(sem => {
        const semData = semestersData[sem];
        // Sort subject codes to have consistent columns
        const subjects = Array.from(semData.subjectCodes).sort();
        
        // Find all unique "Unknown" keys if column map failed on some pages
        semData.students.forEach(std => {
            Object.keys(std.grades).forEach(code => {
                if (code.startsWith('Unknown') && !subjects.includes(code)) {
                    subjects.push(code);
                }
            });
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'semester-section';
        
        const title = document.createElement('h2');
        title.className = 'semester-title';
        title.innerText = sem === 'Unknown' ? 'Unknown Semester' : `Semester ${sem}`;
        wrapper.appendChild(title);
        
        const table = document.createElement('table');
        
        // Create headers
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = `
            <th>Reg. Number</th>
            <th>Student Name</th>
        `;
        subjects.forEach(subj => {
            const th = document.createElement('th');
            th.innerText = subj;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        
        // Create body
        const tbody = document.createElement('tbody');
        
        // Sort students by Reg Number
        const sortedStudents = Array.from(semData.students.values()).sort((a, b) => a.regNumber.localeCompare(b.regNumber));
        
        sortedStudents.forEach(student => {
            const row = document.createElement('tr');
            let rowHTML = `
                <td>${student.regNumber}</td>
                <td>${student.studentName}</td>
            `;
            
            subjects.forEach(subj => {
                 let grade = student.grades[subj] || '-';
                 rowHTML += `<td>${grade}</td>`;
            });
            
            row.innerHTML = rowHTML;
            tbody.appendChild(row);
        });
        
        table.appendChild(tbody);
        wrapper.appendChild(table);
        container.appendChild(wrapper);
    });
}

// Automatically load data.pdf on page load
window.addEventListener('DOMContentLoaded', async () => {
    const tablesContainer = document.getElementById('tablesContainer');
    
    // Show loading state
    if(loadingIndicator) loadingIndicator.style.display = 'block';
    if(tablesContainer) tablesContainer.innerHTML = '<p>Loading result database (data.pdf)...</p>';

    try {
        const response = await fetch('data.pdf');
        if (!response.ok) {
            throw new Error(`Failed to fetch data.pdf (HTTP ${response.status})`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        
        // Extract using coordinate parsing
        const results = await processPDF(arrayBuffer);
        console.log("Extraction Complete. Parsed Semesters:", Object.keys(results));
        console.log("Global Data Array (window.allExtractedData):", window.allExtractedData);

        displayResults(results);
    } catch (error) {
        console.error('Error processing PDF:', error);
        if(tablesContainer) {
            tablesContainer.innerHTML = `
                <div style="color: red; padding: 20px; border: 1px solid red; background: #fff;">
                    <h3>Error Loading Data</h3>
                    <p>${error.message}</p>
                    <p>Make sure <b>data.pdf</b> is in the same folder as index.html and you are running a local server.</p>
                </div>
            `;
        }
    } finally {
        // Hide loading state
        if(loadingIndicator) loadingIndicator.style.display = 'none';
    }
});
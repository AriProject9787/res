// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const regInput = document.getElementById('regNumberInput');
const searchBtn = document.getElementById('viewResultBtn');
const resultOutput = document.getElementById('resultOutput');
const loader = document.getElementById('loadingIndicator');

// Global storage for the extracted data
let semestersData = null;

// Function to extract text and coordinates (optimized for quick search)
async function processPDF(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;
    let semsData = {};
    
    let currentSemesterNo = 'Unknown';
    let currentColumnMap = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items;

        let rowsMap = new Map();
        items.forEach(item => {
            const y = Math.round(item.transform[5] / 3) * 3;
            if (!rowsMap.has(y)) rowsMap.set(y, []);
            rowsMap.get(y).push({
                text: item.str.trim(),
                x: item.transform[4],
                y: item.transform[5]
            });
        });

        const sortedY = Array.from(rowsMap.keys()).sort((a, b) => b - a);
        let rows = sortedY.map(y => rowsMap.get(y));
        rows.forEach(row => row.sort((a, b) => a.x - b.x));

        // Detect semester
        let detectedSemesterNo = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].str.includes('Semester No.')) {
                const match = items[i].str.match(/Semester No\.\s*:\s*0*(\d+)/);
                if (match) detectedSemesterNo = match[1];
                break;
            }
        }
        if (detectedSemesterNo) currentSemesterNo = detectedSemesterNo;
        
        if (!semsData[currentSemesterNo]) {
            semsData[currentSemesterNo] = { subjectCodes: new Set(), students: new Map() };
        }
        const currentSem = semsData[currentSemesterNo];

        // Header detection
        let headerRowIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const rowText = rows[i].map(r => r.text).join(' ');
            if (rowText.includes('Reg. Number') || rowText.includes('Stud. Name')) {
                headerRowIndex = i;
                break;
            }
        }

        const xTolerance = 12;
        if (headerRowIndex > 1) {
             let tempColumnMap = [];
             let candidates = [...rows[headerRowIndex - 2], ...rows[headerRowIndex - 1]];
             let xGroups = [];
             candidates.forEach(cand => {
                 if (!cand.text || ['Subject', 'Code', '-', '>'].includes(cand.text)) return;
                 let foundGroup = xGroups.find(g => Math.abs(g.x - cand.x) < xTolerance);
                 if (foundGroup) {
                     foundGroup.items.push(cand);
                     foundGroup.x = (foundGroup.x + cand.x) / 2;
                 } else {
                     xGroups.push({ x: cand.x, items: [cand] });
                 }
             });
             
             xGroups.forEach(group => {
                 group.items.sort((a,b) => b.y - a.y);
                 const code = group.items.map(i => i.text).join('');
                 if (code.match(/^[A-Z0-9]+$/)) {
                     tempColumnMap.push({ x: group.x, code: code });
                     currentSem.subjectCodes.add(code); 
                 }
             });
             if (tempColumnMap.length > 0) currentColumnMap = tempColumnMap;
        }
        
        const regNumRegex = /^(\d{12})$/;
        const gradeTokensRegex = /^(O|A\+|A|B\+|B|C|U|UA|W|WH|I)$/;
        let scanStartIndex = headerRowIndex !== -1 ? headerRowIndex + 1 : 0;

        for (let i = scanStartIndex; i < rows.length; i++) {
            const row = rows[i];
            let regNumItem = row.find(item => regNumRegex.test(item.text));
            if (!regNumItem) continue;

            const regNumber = regNumItem.text;
            let studentNameParts = [];
            let gradeResults = {};
            
            row.forEach(item => {
                if (item === regNumItem) return;
                const isGradeString = gradeTokensRegex.test(item.text);
                let matchedCol = null;
                if (isGradeString) {
                     matchedCol = currentColumnMap.find(col => Math.abs(col.x - item.x) < xTolerance);
                }
                
                if (isGradeString && matchedCol) {
                    gradeResults[matchedCol.code] = item.text;
                } else if (item.text.length > 0) {
                    studentNameParts.push(item.text);
                }
            });

            if (Object.keys(gradeResults).length === 0) {
                let unknownIndex = 1;
                for (let k = studentNameParts.length - 1; k >= 0; k--) {
                     if (gradeTokensRegex.test(studentNameParts[k])) {
                          gradeResults[`Unknown${unknownIndex++}`] = studentNameParts[k];
                          studentNameParts.pop();
                     } else { break; }
                }
            }
            
            let fullStudentName = studentNameParts.join(' ');
            if (!currentSem.students.has(regNumber)) {
                currentSem.students.set(regNumber, { regNumber, studentName: fullStudentName, grades: gradeResults });
            } else {
                const existing = currentSem.students.get(regNumber);
                Object.assign(existing.grades, gradeResults);
                if (!existing.studentName && fullStudentName) existing.studentName = fullStudentName;
            }
        }
    }
    return semsData;
}

// Function to render the Mark Sheet card
function renderMarkSheet(student, semester) {
    const grades = student.grades;
    const subjectCodes = Object.keys(grades).sort();
    
    let gradesRowsHtml = subjectCodes.map(code => `
        <tr>
            <td>${code}</td>
            <td>${grades[code]}</td>
            <td class="${grades[code] === 'U' || grades[code] === 'UA' ? 'fail' : 'pass'}">
                ${grades[code] === 'U' || grades[code] === 'UA' ? 'F' : 'P'}
            </td>
        </tr>
    `).join('');

    return `
        <div class="marks-card animate-in">
            <div class="card-header">
                <img src="https://upload.wikimedia.org/wikipedia/en/4/47/Anna_University_logo.png" alt="Anna University Logo" class="card-logo">
                <div class="header-text">
                    <h2>ANNA UNIVERSITY, CHENNAI</h2>
                    <h3>PROVISIONAL STATEMENT OF MARKS</h3>
                </div>
            </div>
            
            <div class="student-info">
                <div class="info-row">
                    <span class="label">Name of the Candidate:</span>
                    <span class="value">${student.studentName}</span>
                </div>
                <div class="info-row">
                    <span class="label">Registration Number:</span>
                    <span class="value">${student.regNumber}</span>
                </div>
                <div class="info-row">
                    <span class="label">Semester:</span>
                    <span class="value">${semester}</span>
                </div>
            </div>

            <table class="marks-table">
                <thead>
                    <tr>
                        <th>Subject Code</th>
                        <th>Grade</th>
                        <th>Result</th>
                    </tr>
                </thead>
                <tbody>
                    ${gradesRowsHtml}
                </tbody>
            </table>

            <div class="card-footer">
                <p>Digital copy generated on ${new Date().toLocaleDateString()}</p>
                <div class="seal">COE AUTHENTICATED</div>
            </div>
        </div>
    `;
}

// Event Listeners
searchBtn.addEventListener('click', async () => {
    const regNum = regInput.value.trim();
    if (!regNum || regNum.length !== 12) {
        alert("Please enter a valid 12-digit registration number.");
        return;
    }

    resultOutput.innerHTML = '';
    loader.style.display = 'block';

    try {
        // Fetch and process if not already done
        if (!semestersData) {
            const resp = await fetch('data.pdf');
            const buf = await resp.arrayBuffer();
            semestersData = await processPDF(buf);
        }

        // Search for student in all semesters
        let matches = [];

        // Sort semesters numerically for better display order
        const sortedSems = Object.keys(semestersData).sort((a, b) => {
            let na = parseInt(a), nb = parseInt(b);
            if (isNaN(na)) na = 999;
            if (isNaN(nb)) nb = 999;
            return na - nb;
        });

        sortedSems.forEach(sem => {
            if (semestersData[sem].students.has(regNum)) {
                matches.push({
                    student: semestersData[sem].students.get(regNum),
                    semester: sem
                });
            }
        });

        if (matches.length > 0) {
            let finalHtml = '';
            matches.forEach(match => {
                finalHtml += renderMarkSheet(match.student, match.semester);
            });
            resultOutput.innerHTML = finalHtml;
        } else {
            resultOutput.innerHTML = `
                <div class="error-msg">
                    <h3>Result Not Found</h3>
                    <p>No records found for Registration Number: <b>${regNum}</b></p>
                </div>
            `;
        }
    } catch (e) {
        console.error(e);
        resultOutput.innerHTML = `<p class="error">Error fetching data: ${e.message}</p>`;
    } finally {
        loader.style.display = 'none';
    }
});

// Allow Enter key to trigger search
regInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchBtn.click();
});
